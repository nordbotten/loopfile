/**
 * The CLI's side of a step command call (ADR 0005): opens the attempt socket
 * named by `LOOPFILE_ENDPOINT`, sends one request line and waits for one
 * reply line. What a request and a reply mean belongs to each step command's
 * own module — `data get`'s is `src/application/data-get.ts` — this file only
 * carries bytes and turns a socket that never answers into the same kind of
 * refusal a stale attempt would give.
 */

import { connect } from "node:net";
import { readDataGetReply, type StepGetResult } from "../application/data-get.ts";
import { readDataPutReply } from "../application/data-put.ts";
import { encodeMessage } from "../application/owner-protocol.ts";
import { readResultReply } from "../application/result.ts";
import type { StepReport } from "../application/step-commands.ts";

/** How long a call waits for a reply before treating a gone run owner as a refusal. */
export const CALL_TIMEOUT_MS = 30_000;

/** The attempt identity a step's process gets from its environment (ADR 0005). */
export interface AttemptEnv {
  readonly endpoint: string;
  readonly attemptId: string;
  readonly secret: string;
  /** Only a Ralph step has one. */
  readonly iteration?: number;
}

/**
 * Sends one call over the attempt socket and resolves with the one reply line
 * it gets back, decoded as JSON.
 *
 * Never rejects: a refusal, a timeout, a socket that never connects and a
 * reply line that is not even JSON all resolve as `{ ok: false, message }`,
 * the shape every step command's reply reader already treats as unfixable.
 * That keeps a stray process bound at the socket path from turning into an
 * uncaught rejection instead of the same stderr report any other refusal gets.
 */
export function callAttempt(env: AttemptEnv, argv: readonly string[]): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect(env.endpoint);
    let settled = false;

    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => onTimeout(finish), CALL_TIMEOUT_MS);
    timer.unref?.();

    const onConnect = () => socket.write(encodeMessage(requestOf(env, argv)));
    const onData = readLines((line) => finish(parseReply(line)));
    const onError = (error: Error) => finish({ ok: false, message: error.message });
    const onClose = () => finish({ ok: false, message: "the run owner closed the connection" });

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function onTimeout(finish: (value: unknown) => void): void {
  finish({ ok: false, message: `no answer from the run owner within ${CALL_TIMEOUT_MS}ms` });
}

/** The one request line `data get` and every other step command send. */
function requestOf(env: AttemptEnv, argv: readonly string[]): unknown {
  return {
    attemptId: env.attemptId,
    secret: env.secret,
    ...(env.iteration === undefined ? {} : { iteration: env.iteration }),
    argv,
  };
}

/** A reply line as JSON, or the same unfixable shape a refusal already has. */
function parseReply(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    return { ok: false, message: `reply was not JSON: ${String(error)}` };
  }
}

/** Buffers `data` chunks and calls `onLine` once for the first complete line. */
function readLines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let pending = "";
  let done = false;
  return (chunk) => {
    if (done) return;
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const line = lines.find((candidate) => candidate !== "");
    if (line === undefined) return;
    done = true;
    onLine(line);
  };
}

/** Calls `data get <key>` over the attempt socket and decodes the reply. */
export async function dataGet(env: AttemptEnv, key: string): Promise<StepGetResult> {
  const reply = await callAttempt(env, ["data", "get", key]);
  return readDataGetReply(reply, key);
}

/**
 * Calls `data put <key>` over the attempt socket, sending `content` as the
 * request's base64 argument, and decodes the reply.
 */
export async function dataPut(
  env: AttemptEnv,
  key: string,
  content: Uint8Array,
): Promise<StepReport> {
  const reply = await callAttempt(env, [
    "data",
    "put",
    key,
    Buffer.from(content).toString("base64"),
  ]);
  return readDataPutReply(reply, key, "put");
}

/** Calls `data append <key> <value>` over the attempt socket and decodes the reply. */
export async function dataAppend(env: AttemptEnv, key: string, value: string): Promise<StepReport> {
  const reply = await callAttempt(env, [
    "data",
    "append",
    key,
    Buffer.from(value, "utf8").toString("base64"),
  ]);
  return readDataPutReply(reply, key, "append");
}

/** Calls `result <outcome> [--message <text>]` over the attempt socket and decodes the reply. */
export async function reportResult(
  env: AttemptEnv,
  outcome: string,
  message?: string,
): Promise<StepReport> {
  const reply = await callAttempt(
    env,
    message === undefined ? ["result", outcome] : ["result", outcome, "--message", message],
  );
  return readResultReply(reply, outcome);
}
