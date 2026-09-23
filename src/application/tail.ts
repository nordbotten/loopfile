/**
 * `tail <runid>`: the read-only, following view of a run's `activity.log`
 * (#51).
 *
 * Parsing the command's own arguments, splitting a growing file into whole
 * lines, and recognising an end event line are all pure, so they are tested
 * without a filesystem or a socket. Reading the run folder, following the
 * files, picking the last lines to show at the start and pinging the run
 * owner is `src/adapters/tail-command.ts`.
 *
 * `unknownRunMessage` is re-exported from `logs.ts` (#37): both commands mean
 * the same thing by "unknown run" — no folder under the run's ID — so they
 * say it the same way rather than risk the wording drifting apart.
 */

import type { RunEndReason } from "../domain/events.ts";
import { type RunEnd, runEndFromEvent } from "./run-end.ts";

export { unknownRunMessage } from "./logs.ts";

/** How many lines `tail` prints before it starts following, like `tail -f`. */
export const TAIL_LINE_COUNT = 10;

/** `tail`'s own arguments, once parsed. */
export interface TailArgs {
  readonly ok: true;
  readonly runId: string;
  /** Print `events.jsonl` lines instead of activity lines (#186). */
  readonly json: boolean;
}

/** Why `tail`'s own arguments could not be used. */
export interface TailFailure {
  readonly ok: false;
  readonly message: string;
}

const USAGE = "Usage: loopfile tail <runid|loopid> [--json]";

/** `tail`'s own arguments, or the failure to report when they are unusable. */
export function parseTailArgs(argv: readonly string[]): TailArgs | TailFailure {
  const json = argv.includes("--json");
  const rest = argv.slice(1).filter((token) => token !== "--json");
  const runId = rest[0];
  if (!runId || runId.startsWith("--")) {
    return { ok: false, message: `\`tail\` needs a run ID.\n${USAGE}` };
  }
  if (rest.length > 1) {
    return { ok: false, message: `unknown argument: ${rest[1]}\n${USAGE}` };
  }
  return { ok: true, runId, json };
}

export function missingActivityLogMessage(runId: string): string {
  return `run ${runId} has no activity log yet`;
}

export function ownerGoneMessage(runId: string): string {
  return `the run owner for ${runId} is gone`;
}

/**
 * `buffer` split into the whole lines it holds and whatever partial line is
 * still waiting on a newline, so a follower reading a file as it grows never
 * prints a line before it is complete.
 */
export function splitCompleteLines(buffer: string): {
  readonly lines: readonly string[];
  readonly remainder: string;
} {
  const parts = buffer.split("\n");
  const remainder = parts.pop() ?? "";
  return { lines: parts, remainder };
}

/**
 * How the run ended, if `line` is a `run.ended` or `run.cancelled` line of
 * `events.jsonl`.
 *
 * `tail` only ever checks for the end this way, one line at a time, rather
 * than replaying the log into run state: the event log is the source of
 * truth (ADR 0003), but a reader that only watches for the end does not need
 * to rebuild it, and staying this simple is what keeps `tail` read-only and
 * cheap to run alongside the run it watches.
 *
 * It gives back the end rather than a yes/no because the caller has to say
 * how the run ended, not only that it did (#185). A line that is not JSON or
 * not an object is nothing: a half-written line is normal while the file
 * grows, and a line `tail` cannot read is one it goes on past rather than
 * stops on.
 *
 * A `run.ended` whose `result` or `reason` does not read still ends the run:
 * the run owner has stopped either way, and a follower that held out for a
 * better line would follow for ever. It reads as a failure, never a success,
 * so `tail` only ever exits 0 for a run whose own end event says `success`.
 */
export function endInLine(runId: string, line: string): RunEnd | undefined {
  const event = parseObjectLine(line);
  if (event === undefined) return undefined;
  if (event.type === "run.cancelled") return runEndFromEvent(runId, { type: "run.cancelled" });
  if (event.type !== "run.ended") return undefined;
  return runEndFromEvent(runId, {
    type: "run.ended",
    result: event.result === "success" ? "success" : "failure",
    reason: endReasonOf(event.reason),
    stepId: typeof event.stepId === "string" ? event.stepId : undefined,
    metrics: denialMetrics(event.metrics),
  });
}

function denialMetrics(value: unknown): { readonly permissionDenials: number | null } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const permissionDenials = (value as Record<string, unknown>).permissionDenials;
  return typeof permissionDenials === "number" || permissionDenials === null
    ? { permissionDenials }
    : undefined;
}

/** `line` read as a JSON object, or nothing when it is blank, not JSON or not an object. */
function parseObjectLine(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** `value` as an end reason, or `end_state` when it is not one this version knows. */
function endReasonOf(value: unknown): RunEndReason {
  return RUN_END_REASONS.has(value as RunEndReason) ? (value as RunEndReason) : "end_state";
}

/** Every value `RunEndReason` may hold, for a runtime check against a parsed line. */
const RUN_END_REASONS: ReadonlySet<RunEndReason> = new Set<RunEndReason>([
  "end_state",
  "attempt_limit",
  "transition_limit",
  "run_timeout",
  "internal_error",
]);

/**
 * `lines` up to and including the first end event, and how the run ended.
 * Every line and no end when none of them is an end event. `tail --json`
 * prints the lines, so it never prints past the end it stops on (#186).
 */
export function throughEnd(
  runId: string,
  lines: readonly string[],
): { readonly lines: readonly string[]; readonly end: RunEnd | undefined } {
  for (const [index, line] of lines.entries()) {
    const end = endInLine(runId, line);
    if (end !== undefined) return { lines: lines.slice(0, index + 1), end };
  }
  return { lines, end: undefined };
}
