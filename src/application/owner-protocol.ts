/**
 * What the run owner's two sockets say to each other (#115).
 *
 * The control socket (ADR 0008) is how a reader learns a run owner is alive
 * and how the CLI waits for "ready". The attempt socket (ADR 0005) is what a
 * step's data and result commands reach over `LOOPFILE_ENDPOINT`.
 *
 * Both carry one JSON object on each line. Only the helper CLI and the run
 * owner ever see this, so the format is the implementer's pick and nothing
 * else depends on it (ADR 0005).
 *
 * Everything here is pure: text in, decision out. Binding, connecting and
 * unlinking are the adapter's (`src/adapters/run-owner.ts`), so the rules that
 * decide whether a call is answered can be tested without a socket.
 */

import type { AttemptId } from "../domain/model.ts";

/** A ping asks a run owner who it is. The reply proves the socket is not stale. */
export const PING = "ping";

/** Asks the run owner to stop the run (#63, ADR 0008). */
export const CANCEL = "cancel";

/** Asks the run owner to stop the current attempt and start it again (#53). */
export const INTERRUPT = "interrupt";

/** The reply to a ping: the run ID is what makes a stale socket tell itself apart. */
export interface Pong {
  readonly type: "pong";
  readonly runId: string;
}

/**
 * The run owner can take work (ADR 0008). Sent unasked, once per connection,
 * and only once the run owner is past the setup that can still fail.
 */
export interface Ready {
  readonly type: "ready";
  readonly runId: string;
}

/**
 * The run owner took a cancel: it stops the current attempt, writes
 * `run.cancelled`, removes the socket and exits (#63).
 */
export interface Cancelling {
  readonly type: "cancelling";
  readonly runId: string;
}

/** The run owner took an interrupt and is stopping the current attempt (#53). */
export interface Interrupting {
  readonly type: "interrupting";
  readonly runId: string;
}

/** A request the control socket does not know. */
export interface ControlError {
  readonly type: "error";
  readonly message: string;
}

/** Everything the control socket sends. */
export type ControlMessage = Pong | Ready | Cancelling | Interrupting | ControlError;

/** Why the attempt socket refused a call. */
export type RefusalCode = "stale_attempt" | "bad_request";

/** A refused attempt call. The step's own error codes are a different surface. */
export interface AttemptRefusal {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly message: string;
}

/**
 * The attempt, and on a Ralph step the iteration, that is running now.
 *
 * A step gets a new secret for each attempt, and a Ralph step for each
 * iteration (ADR 0005), so this is what a call has to match to be answered.
 */
export interface AttemptIdentity {
  readonly attemptId: AttemptId;
  readonly secret: string;
  /** Only a Ralph step has one. Iterations count from 1. */
  readonly iteration?: number;
}

/** A call a step made, once it has been shown to belong to the running attempt. */
export interface AttemptCall extends AttemptIdentity {
  /** The step command's own arguments. Its meaning belongs to #19, #20 and #26. */
  readonly argv: readonly string[];
}

/** A call the run owner answers, or the refusal it sends back instead. */
export type AttemptCallCheck =
  | { readonly accepted: true; readonly call: AttemptCall }
  | { readonly accepted: false; readonly refusal: AttemptRefusal };

/** One message as a line, ready to write. */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** One line as an object, or nothing when it is not one. */
export function decodeMessage(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The greeting every client gets once the run owner can take work. */
export function readyMessage(runId: string): Ready {
  return { type: "ready", runId };
}

/**
 * The run ID a control socket answered with, or nothing when the answer is not
 * a run owner's.
 *
 * Liveness under ADR 0008 is "the socket answers with the right run ID", so a
 * reader has to read the ID rather than count bytes: something else bound at
 * the path answers too, and it is not this run's owner.
 */
export function answeredRunId(line: string): string | undefined {
  const message = decodeMessage(line);
  if (message?.type !== "pong" && message?.type !== "ready") return undefined;
  return typeof message.runId === "string" ? message.runId : undefined;
}

/** Whether `line` is the run owner of `runId` saying it took the cancel. */
export function confirmsCancel(line: string, runId: string): boolean {
  const message = decodeMessage(line);
  return message?.type === "cancelling" && message.runId === runId;
}

/** Whether `line` confirms that this run took an interrupt. */
export function confirmsInterrupt(line: string, runId: string): boolean {
  const message = decodeMessage(line);
  return message?.type === "interrupting" && message.runId === runId;
}

/** Whether `line` says there is no attempt for an interrupt to stop. */
export function refusesInterrupt(line: string): boolean {
  const message = decodeMessage(line);
  return message?.type === "error" && message.message === "no attempt is running";
}

/**
 * What the control socket answers.
 *
 * A ping is answered with the run ID, which is what liveness means under ADR
 * 0008: a socket that answers with the right run ID belongs to a live run
 * owner. Anything else is named back to the caller rather than ignored, so a
 * client never waits on a reply that is not coming.
 */
export function controlReply(line: string, runId: string, canInterrupt = true): ControlMessage {
  const request = decodeMessage(line);
  if (request === undefined) return { type: "error", message: "request is not a JSON object" };
  if (request.type === PING) return { type: "pong", runId };
  if (request.type === CANCEL) return { type: "cancelling", runId };
  if (request.type === INTERRUPT) {
    return canInterrupt
      ? { type: "interrupting", runId }
      : { type: "error", message: "no attempt is running" };
  }
  return { type: "error", message: `unknown request ${JSON.stringify(request.type)}` };
}

/**
 * Whether a call on the attempt socket belongs to the attempt that is running
 * now (ADR 0005).
 *
 * The attempt ID and the secret must both match, and on a Ralph step so must
 * the iteration: a process left over from an ended attempt or an ended
 * iteration still has a working socket path and its own environment. This is
 * not a security boundary — the agent can read its own environment — it keeps
 * a straggler from writing into the attempt that took its place.
 */
export function checkAttemptCall(
  line: string,
  current: AttemptIdentity | undefined,
): AttemptCallCheck {
  const request = decodeMessage(line);
  if (request === undefined) return refuse("bad_request", "request is not a JSON object");
  const argv = readArgv(request.argv);
  if (argv === undefined) return refuse("bad_request", "request has no argv of strings");
  if (current === undefined) return refuse("stale_attempt", "no iteration is running");
  if (request.attemptId !== current.attemptId || request.secret !== current.secret) {
    return refuse("stale_attempt", `not the attempt running now (${current.attemptId})`);
  }
  if (!sameIteration(request.iteration, current.iteration)) {
    return refuse("stale_attempt", `not the iteration running (${iterationNow(current)})`);
  }
  return { accepted: true, call: { ...current, argv } };
}

/** The call's arguments, or nothing when they are not a list of words. */
function readArgv(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((word) => typeof word === "string") ? (value as string[]) : undefined;
}

/** A step with no iterations and iteration 1 are different things, so `null` stands in. */
function sameIteration(called: unknown, running: number | undefined): boolean {
  return (called ?? null) === (running ?? null);
}

function iterationNow(current: AttemptIdentity): string {
  return current.iteration === undefined
    ? "this step has no iterations"
    : `now ${current.iteration}`;
}

function refuse(code: RefusalCode, message: string): AttemptCallCheck {
  return { accepted: false, refusal: { ok: false, code, message } };
}
