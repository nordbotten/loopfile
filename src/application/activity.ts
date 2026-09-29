/**
 * Turning a run event into an activity log line, and filtering any line
 * before it is written (#50, ADR 0007).
 *
 * `activity.log` gets one plain-text line per message: step start and end,
 * the route taken, the outcome, and each data or result command. Those come
 * straight from the run owner's own events, with no harness support, so this
 * reads a `RunEvent` and says what (if anything) it is worth to a reader
 * following the log. Harness lines are #25a's to build; this only says how
 * every line, harness or lifecycle, is made safe before `adapters/activity-log.ts`
 * appends it.
 */

import type { CallFields, RunEvent } from "../domain/events.ts";
import type { AttemptId } from "../domain/model.ts";

/** About how long a line may run before it is cut (ADR 0007: "about 200 characters"). */
export const ACTIVITY_LINE_MAX_CHARS = 200;

/** Marks a line that was cut for length. */
const TRUNCATION_SUFFIX = "…";

/** Values a filtered line may never contain (ADR 0007: environment values, the attempt secret). */
export interface ActivitySecrets {
  /** This attempt's `LOOPFILE_ATTEMPT_SECRET`, when there is one to guard. */
  readonly attemptSecret?: string;
  /** Any other value that must not reach the file, such as an env var's value. */
  readonly environmentValues?: readonly string[];
}

/**
 * Cuts `text` to one line of about 200 characters, with every secret value
 * replaced by `***`.
 *
 * Newlines and runs of whitespace collapse to a single space first, so a
 * multi-line message becomes one line before it is measured, matching what
 * `tail -f` shows: one whole line per message, however the source message was
 * shaped.
 */
export function filterActivityText(text: string, secrets: ActivitySecrets = {}): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  const redacted = redact(collapsed, secrets);
  if (redacted.length <= ACTIVITY_LINE_MAX_CHARS) return redacted;
  return redacted.slice(0, ACTIVITY_LINE_MAX_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function redact(text: string, secrets: ActivitySecrets): string {
  const values = [secrets.attemptSecret, ...(secrets.environmentValues ?? [])].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  let result = text;
  for (const value of values) result = result.split(value).join("***");
  return result;
}

/** One lifecycle line: which attempt it belongs to, if any, and its unfiltered text. */
export interface ActivityLine {
  readonly attemptId: AttemptId | null;
  readonly text: string;
}

/**
 * The lifecycle line one run event is worth in `activity.log`, or nothing for
 * an event ADR 0007 does not name: `activity.log` only gets step start and
 * end, the route taken, the outcome, and each data or result command.
 */
export function activityLineForEvent(event: RunEvent): ActivityLine | null {
  const line = LINES[event.type] as ((event: RunEvent) => ActivityLine) | undefined;
  return line === undefined ? null : line(event);
}

type EventOf<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

/** Each event type ADR 0007 names, and the line it makes. */
const LINES: { readonly [T in RunEvent["type"]]?: (event: EventOf<T>) => ActivityLine } = {
  "attempt.started": (event) => ({
    attemptId: event.attemptId,
    text: `step started${formatCallFields(event.fields)}`,
  }),
  "iteration.started": (event) => ({
    attemptId: event.attemptId,
    text: `iteration ${event.iteration} started${formatCallFields(event.fields)}`,
  }),
  "attempt.ended": (event) => ({
    attemptId: event.attemptId,
    text: `step ended ${attemptEndText(event)}`,
  }),
  "attempt.interrupted": (event) => ({ attemptId: event.attemptId, text: "step interrupted" }),
  "run.cancelled": () => ({ attemptId: null, text: "run cancelled" }),
  "outcome.reported": (event) => ({ attemptId: event.attemptId, text: `outcome ${event.outcome}` }),
  transition: (event) => ({
    attemptId: event.attemptId,
    text: `route ${event.from} -> ${event.to}`,
  }),
  "data.get": (event) => ({ attemptId: event.attemptId, text: `data get ${event.key}` }),
  "data.put": (event) => ({
    attemptId: event.attemptId,
    text: `data ${event.appended === true ? "append" : "put"} ${event.key}`,
  }),
};

function formatCallFields(fields: CallFields | undefined): string {
  if (fields === undefined) return "";
  const text = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} ${value}`)
    .join(" ");
  return text === "" ? "" : ` ${text}`;
}

function attemptEndText(event: Extract<RunEvent, { type: "attempt.ended" }>): string {
  if (event.reason !== "bad_field") return event.reason.replaceAll("_", " ");
  return `bad field${event.field === undefined ? "" : ` ${event.field}`}${event.value === undefined ? "" : ` ${JSON.stringify(event.value)}`}`;
}

/**
 * One `activity.log` line: local `HH:MM:SS`, the attempt ID when there is
 * one, then the filtered text. `at` is local time (not UTC, unlike an
 * event's timestamp), because the file is for a person watching `tail -f`,
 * not a parser.
 */
export function formatActivityLine(at: Date, attemptId: AttemptId | null, text: string): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return attemptId === null ? `${time} ${text}` : `${time} ${attemptId} ${text}`;
}
