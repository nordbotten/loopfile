/**
 * `result <outcome> [--message <text>]`: the wire shape of a step's outcome
 * report (#26).
 *
 * Parsing the command's own arguments and turning the run owner's reply into
 * a step report are both pure, so they are tested without a socket. Opening
 * the socket is `src/adapters/attempt-client.ts`; deciding whether an outcome
 * is accepted is `src/adapters/result-handler.ts` (#85); this file only
 * speaks the line between them.
 */

import type { RunEvent } from "../domain/events.ts";
import type { AttemptId, Outcome } from "../domain/model.ts";
import type { StepFailure, StepReport } from "./step-commands.ts";

/** A `--message` longer than this is cut on a UTF-8 boundary (#85). */
export const MESSAGE_LIMIT_BYTES = 500;

/** `result <outcome> [--message <text>]`'s own arguments, once parsed. */
export interface ResultArgs {
  readonly ok: true;
  readonly outcome: string;
  readonly message?: string;
  /** True when `--message` was cut to fit `MESSAGE_LIMIT_BYTES`. */
  readonly truncated: boolean;
}

/** `result`'s own arguments, or the failure to report when they are unusable. */
export function parseResultArgs(argv: readonly string[]): ResultArgs | StepFailure {
  const outcome = argv[1];
  if (outcome === undefined || outcome === "") {
    return {
      ok: false,
      summary: "`result` needs an outcome",
      code: "missing_arg",
      help: [
        "Usage: loopfile result <outcome> [--message <text>]",
        "The outcome must be one of the step's `on` keys",
      ],
    };
  }

  const rawMessage = readMessageFlag(argv);
  if (rawMessage === undefined) return { ok: true, outcome, truncated: false };

  const { message, truncated } = sanitizeMessage(rawMessage);
  return { ok: true, outcome, message, truncated };
}

/**
 * `--message`'s value, or nothing when the flag is absent. Shared with
 * `adapters/result-handler.ts`, which reads the same flag out of the wire
 * call's own `argv` once the CLI has already sanitized it.
 */
export function readMessageFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--message");
  if (index === -1) return undefined;
  return argv[index + 1] ?? "";
}

/**
 * Replaces newlines and control characters with a space, then cuts to
 * `MESSAGE_LIMIT_BYTES` on a UTF-8 boundary. Cut rather than refused (#85): no
 * failed attempt and no wasted agent turn over a log string.
 */
function sanitizeMessage(raw: string): { message: string; truncated: boolean } {
  const cleaned = raw.replace(/[\p{Cc}]/gu, " ");
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.byteLength <= MESSAGE_LIMIT_BYTES) return { message: cleaned, truncated: false };
  return { message: truncateUtf8(bytes, MESSAGE_LIMIT_BYTES).toString("utf8"), truncated: true };
}

/** The longest prefix of `bytes` within `maxBytes` that does not split a UTF-8 character. */
function truncateUtf8(bytes: Buffer, maxBytes: number): Buffer {
  let end = maxBytes;
  while (end > 0 && (bytes.at(end) ?? 0) >> 6 === 0b10) end -= 1;
  return bytes.subarray(0, end);
}

/**
 * Turns the run owner's raw reply for a `result` call into a step report.
 *
 * The reply is untyped on this side of the wire, so every field is checked
 * before it is trusted. `ok: true` is the only success shape; every other
 * reply, including one this side cannot make sense of, is the run's problem
 * and reads as `stale_attempt`.
 */
export function readResultReply(reply: unknown, outcome: string): StepReport {
  const record = asRecord(reply);
  if (record?.ok === true) return { ok: true, summary: `reported ${outcome}` };
  if (record?.code === "bad_outcome") return badOutcome(replyMessage(record), record.allowed);
  return staleAttempt(replyMessage(record));
}

function badOutcome(message: string, allowed: unknown): StepFailure {
  return {
    ok: false,
    summary: message,
    code: "bad_outcome",
    help: [message, ...allowedLine(allowed)],
  };
}

/** The allowed-outcomes help line a `bad_outcome` reply carries, if any (#85). */
function allowedLine(allowed: unknown): readonly string[] {
  if (!Array.isArray(allowed) || !allowed.every((value) => typeof value === "string")) return [];
  return [
    allowed.length > 0
      ? `Allowed outcomes: ${allowed.join(", ")}`
      : "This step has no `on` map, so no outcome is allowed",
  ];
}

function staleAttempt(message: string): StepFailure {
  return {
    ok: false,
    summary: `\`result\` was refused: ${message}`,
    code: "stale_attempt",
    help: ["This attempt or iteration has ended; nothing here can be retried"],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function replyMessage(record: Record<string, unknown> | undefined): string {
  return typeof record?.message === "string" ? record.message : "no answer from the run owner";
}

/** Whether a `result` call may be accepted, or the reason and allowed outcomes to refuse with. */
export type ResultCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly allowed: readonly Outcome[] };

/**
 * Checks a `result` call against the run so far and the step's own `on` keys
 * (#85): one outcome per attempt, reset each Ralph iteration, and only an
 * outcome that is a key of `on` is ever accepted. The only caller is
 * `src/adapters/result-handler.ts`, which appends the event this decides.
 */
export function checkResult(
  history: readonly RunEvent[],
  attemptId: AttemptId,
  iteration: number | undefined,
  outcome: string,
  allowedOutcomes: readonly Outcome[],
): ResultCheck {
  const already = alreadyReported(history, attemptId, iteration);
  if (already !== undefined) {
    return { ok: false, reason: `outcome already reported: ${already}`, allowed: allowedOutcomes };
  }
  if (!allowedOutcomes.includes(outcome)) {
    return {
      ok: false,
      reason: `"${outcome}" is not one of this step's outcomes`,
      allowed: allowedOutcomes,
    };
  }
  return { ok: true };
}

/** The outcome an earlier accepted call of this attempt (this iteration) already reported. */
function alreadyReported(
  history: readonly RunEvent[],
  attemptId: AttemptId,
  iteration: number | undefined,
): Outcome | undefined {
  const reported = history.find(
    (event): event is Extract<RunEvent, { type: "outcome.reported" }> =>
      event.type === "outcome.reported" &&
      event.attemptId === attemptId &&
      sameIteration(event.iteration, iteration),
  );
  return reported?.outcome;
}

/** A step with no iterations and iteration 1 are different things, so `null` stands in. */
function sameIteration(a: number | undefined, b: number | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/** The `outcome.reported` fields an accepted call appends, minus its envelope and `type`. */
export function outcomeReportedFields(
  attemptId: AttemptId,
  iteration: number | undefined,
  outcome: string,
  message: string | undefined,
): {
  readonly attemptId: AttemptId;
  readonly iteration?: number;
  readonly outcome: string;
  readonly message?: string;
} {
  return {
    attemptId,
    ...(iteration === undefined ? {} : { iteration }),
    outcome,
    ...(message === undefined ? {} : { message }),
  };
}
