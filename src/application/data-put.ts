/**
 * `data put <key> <file>` and `data append <key> <value>`: the wire shape of a
 * step's write (#20).
 *
 * Parsing each command's own arguments and turning the run owner's reply into
 * a step report are both pure, so they are tested without a socket. Reading
 * the file or stdin is `src/cli.ts` (EXEMPT); opening the socket is
 * `src/adapters/attempt-client.ts`; deciding what a put may write is
 * `src/application/data-store.ts` (#18, #20); this file only speaks the line
 * between them.
 */

import type { StepFailure, StepReport } from "./step-commands.ts";

/** `data put <key> <file>`'s own arguments, or the failure to report when either is missing. */
export function parseDataPutArgs(
  argv: readonly string[],
): { key: string; file: string } | StepFailure {
  const key = argv[2];
  const file = argv[3];
  if (key === undefined || key === "" || file === undefined || file === "") {
    return {
      ok: false,
      summary: "`data put` needs a key and a file",
      code: "missing_arg",
      help: [
        "Usage: loopfile data put <key> <file|->",
        "The key is <step>.<name>; the file is a path, or - to read stdin",
      ],
    };
  }
  return { key, file };
}

/** `data append <key> <value>`'s own arguments, or the failure to report when either is missing. */
export function parseDataAppendArgs(
  argv: readonly string[],
): { key: string; value: string } | StepFailure {
  const key = argv[2];
  const value = argv[3];
  if (key === undefined || key === "" || value === undefined) {
    return {
      ok: false,
      summary: "`data append` needs a key and a value",
      code: "missing_arg",
      help: ["Usage: loopfile data append <key> <value>", "The key is <step>.<name>"],
    };
  }
  return { key, value };
}

/**
 * Turns the run owner's raw reply for a `data put`/`data append` call into a
 * step report.
 *
 * The reply is untyped on this side of the wire: it travelled as JSON over a
 * socket, so every field is checked before it is trusted. Anything that is
 * not a recognised success or one of the put refusal codes — a stale attempt,
 * a bad request, a run owner that never answered — is the run's problem, not
 * the step's, and reads as `stale_attempt`: not fixable by calling again.
 */
export function readDataPutReply(reply: unknown, key: string, verb: "put" | "append"): StepReport {
  const record = asRecord(reply);
  if (isPutSuccess(record)) {
    return {
      ok: true,
      summary: `${verb} ${key}`,
      fields: { bytes: String(record.size), digest: record.digest },
    };
  }
  if (record?.code === "invalid_key") return invalidKey(verb, messageOf(record));
  if (record?.code === "write_kind_mismatch") return writeKindMismatch(verb, messageOf(record));
  return staleAttempt(verb, messageOf(record));
}

/** A success reply names the stored size and digest; anything less is not one. */
function isPutSuccess(
  record: Record<string, unknown> | undefined,
): record is { ok: true; size: number; digest: string } {
  return (
    record?.ok === true && typeof record.size === "number" && typeof record.digest === "string"
  );
}

function invalidKey(verb: "put" | "append", message: string): StepFailure {
  return {
    ok: false,
    summary: `\`data ${verb}\` was refused: ${message}`,
    code: "invalid_key",
    help: [
      "Keys are <step>.<name>: lowercase letters, digits, - and _, starting with a letter",
      "A key names the calling attempt's own step, never input.*",
    ],
  };
}

function writeKindMismatch(verb: "put" | "append", message: string): StepFailure {
  return {
    ok: false,
    summary: `\`data ${verb}\` was refused: ${message}`,
    code: "write_kind_mismatch",
    help: ["Use the same command, data put or data append, for every write to one key"],
  };
}

function staleAttempt(verb: "put" | "append", message: string): StepFailure {
  return {
    ok: false,
    summary: `\`data ${verb}\` was refused: ${message}`,
    code: "stale_attempt",
    help: ["This attempt or iteration has ended; nothing here can be retried"],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageOf(record: Record<string, unknown> | undefined): string {
  return typeof record?.message === "string" ? record.message : "no answer from the run owner";
}
