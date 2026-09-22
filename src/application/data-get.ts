/**
 * `data get <key>`: the wire shape of a step's read (#19).
 *
 * Parsing the command's own argument and turning the run owner's reply into a
 * step report are both pure, so they are tested without a socket. Opening the
 * socket is `src/adapters/attempt-client.ts`; deciding what a get may read is
 * `src/application/data-store.ts` (#18); this file only speaks the line
 * between them.
 */

import type { StepFailure, StepReport } from "./step-commands.ts";

/** `data get <key>`'s own argument, or the failure to report when it is missing. */
export function parseDataGetKey(argv: readonly string[]): string | StepFailure {
  const key = argv[2];
  if (key === undefined || key === "") {
    return {
      ok: false,
      summary: "`data get` needs a key",
      code: "missing_arg",
      help: [
        "Usage: loopfile data get <key>",
        "The key names an earlier step's put, or a launch input as input.<name>",
      ],
    };
  }
  return key;
}

/**
 * Turns the run owner's raw reply for a `data get <key>` call into a step
 * report and, on success, the bytes for stdout.
 *
 * The reply is untyped on this side of the wire: it travelled as JSON over a
 * socket, so every field is checked before it is trusted. Anything that is
 * not a recognised success or `unknown_key` refusal — a stale attempt, a bad
 * request, a run owner that never answered — is the run's problem, not the
 * step's, and reads as `stale_attempt`: not fixable by calling again.
 */
export function readDataGetReply(reply: unknown, key: string): StepGetResult {
  const record = asRecord(reply);
  if (record?.ok === true && isPayload(record)) {
    const fields: Record<string, string> = {};
    if (typeof record.attemptId === "string") fields.attempt = record.attemptId;
    fields.bytes = String(record.size);
    return {
      report: { ok: true, summary: `read ${key}`, fields },
      content: Buffer.from(record.content, "base64"),
    };
  }
  if (record?.code === "unknown_key") return { report: unknownKey(key) };
  return { report: staleAttempt(messageOf(record)) };
}

/** What reading a `data get` reply gives back: the report, and its payload on success. */
export interface StepGetResult {
  readonly report: StepReport;
  readonly content?: Buffer;
}

function unknownKey(key: string): StepFailure {
  return {
    ok: false,
    summary: `no data key "${key}"`,
    code: "unknown_key",
    help: [
      "Keys are set by earlier steps; check the step that puts it",
      "Run `loopfile data get <key>` with a key from your prompt",
    ],
  };
}

function staleAttempt(message: string): StepFailure {
  return {
    ok: false,
    summary: `\`data get\` was refused: ${message}`,
    code: "stale_attempt",
    help: ["This attempt or iteration has ended; nothing here can be retried"],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPayload(
  record: Record<string, unknown>,
): record is Record<string, unknown> & { content: string; size: number } {
  return typeof record.content === "string" && typeof record.size === "number";
}

function messageOf(record: Record<string, unknown> | undefined): string {
  return typeof record?.message === "string" ? record.message : "no answer from the run owner";
}
