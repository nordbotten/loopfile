/**
 * Reading `events.jsonl` and rebuilding a run's state from it (ADR 0003).
 *
 * The event log is the source of truth, so every reader — `status`, the
 * monitor, resume — gets its picture from here. Replay is pure: it takes
 * events and returns state, touches no file and no process, and needs no agent
 * conversation state. A run has hundreds of events, so a full replay is cheap
 * and no state file is saved.
 *
 * Two rules from the ADR are worth naming here, because they are the ones that
 * look like bugs when you meet them in the code:
 *
 * - A broken *last* line is a write that a crash cut in half, so it is skipped.
 *   A broken line anywhere else means the log is corrupt, and a caller must
 *   stop rather than run on a state built from part of it.
 * - A step's attempt count is the number of `attempt.started` events for that
 *   step, with nothing subtracted. An interrupted attempt counts toward
 *   `maxAttempts` whatever interrupted it, so there is no second rule.
 */

import {
  EVENT_TYPES,
  type EventRecord,
  type RunCancelled,
  type RunEnded,
  type RunEndReason,
  type RunEvent,
  type Timestamp,
  type Transition,
} from "../domain/events.ts";
import { type AttemptId, isEndState, type StepId } from "../domain/model.ts";

/** Thrown when a line other than the last one is not a readable event. */
export class CorruptEventLogError extends Error {}

/** How a run finished. `cancelled` comes from `run.cancelled`, which has no reason. */
export type RunResult =
  | { readonly result: "success" | "failure"; readonly reason: RunEndReason }
  | { readonly result: "cancelled" };

/** True for a run that ended with `internal_error`, which `resume` takes up and `continue` does not. */
export function isInternalError(result: RunResult): boolean {
  return result.result !== "cancelled" && result.reason === "internal_error";
}

/** True for a run that reached `$success`. */
export function isCompleted(result: RunResult): boolean {
  return result.result === "success" && result.reason === "end_state";
}

/** One transition, in the order it happened. Everything a `transition` event carries but its envelope. */
export type TransitionRecord = Omit<Transition, "seq" | "at" | "type">;

/** A run's state, as rebuilt from its event log. */
export interface RunState {
  readonly runId: string;
  /** Of the built workflow model. Resume continues only when it still matches (ADR 0006). */
  readonly modelDigest: string;
  /**
   * The step the run is at, or the step it last left. Left out before the
   * first attempt starts. A transition to an end state does not change it.
   */
  readonly currentStep?: StepId;
  /**
   * Step ID to its attempt IDs, oldest first. A step never visited is absent.
   * Its length is the step's `attempt.started` count.
   */
  readonly attempts: Readonly<Record<StepId, readonly AttemptId[]>>;
  /** Every transition, oldest first, checked against the workflow's `maxTransitions`. */
  readonly transitions: readonly TransitionRecord[];
  /** Attempts per step since the last `run.continued`, for maxAttempts. */
  readonly attemptsSinceContinue: Readonly<Record<StepId, readonly AttemptId[]>>;
  /** Moves since the last `run.continued`, for maxTransitions. */
  readonly transitionsSinceContinue: readonly TransitionRecord[];
  /** Run owner time since the last `run.continued`, for runTimeout. */
  readonly ownerTimeSinceContinueMs: number;
  /**
   * Run owner time used, summed per `owner.started`. The gap between a crash
   * and the resume that follows it belongs to nobody, so `runTimeout` does not
   * charge the run for the hours a laptop was asleep.
   */
  readonly ownerTimeMs: number;
  readonly createdAt: Timestamp;
  readonly lastEventAt: Timestamp;
  /** Left out while the run is still going. */
  readonly result?: RunResult;
}

/**
 * Reads the text of an `events.jsonl` into events.
 *
 * A half-written last line is dropped, because `fsync` follows each append and
 * only the newest one can be cut short. Anything else that does not read as an
 * event throws: the missing facts are somewhere in the middle of the run.
 */
export function parseEventLog<Event extends EventRecord = RunEvent>(
  text: string,
): readonly Event[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events: Event[] = [];
  for (const [index, line] of lines.entries()) {
    const event = readEvent(line);
    if (event !== undefined) {
      events.push(event as Event);
      continue;
    }
    if (index !== lines.length - 1) {
      throw new CorruptEventLogError(`events.jsonl line ${index + 1} is not a readable event`);
    }
  }
  return events;
}

/** One line as an event, or `undefined` when it is not one. */
function readEvent(line: string): EventRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.seq !== "number" || typeof record.at !== "string") return undefined;
  if (typeof record.type !== "string" || !EVENT_TYPES.has(record.type)) return undefined;
  return value as EventRecord;
}

/**
 * Rebuilds a run's state from its whole event log.
 *
 * The events must start with `run.created`, which is the event that says what
 * the rest of the log belongs to. A log that does not is not a run's log.
 */
export function replay(events: readonly RunEvent[]): RunState {
  const created = events[0];
  if (created?.type !== "run.created") {
    throw new CorruptEventLogError("events.jsonl does not start with run.created");
  }
  const last = events.at(-1) ?? created;
  const currentStep = stepNow(events);
  return {
    runId: created.runId,
    modelDigest: created.modelDigest,
    ...(currentStep === undefined ? {} : { currentStep }),
    attempts: attemptsPerStep(events),
    transitions: transitionRecords(events),
    attemptsSinceContinue: attemptsPerStep(events.slice(lastContinuationIndex(events) + 1)),
    transitionsSinceContinue: transitionRecords(events.slice(lastContinuationIndex(events) + 1)),
    ownerTimeSinceContinueMs: ownerTimeSinceContinueMs(events),
    ownerTimeMs: ownerTimeMs(events),
    createdAt: created.at,
    lastEventAt: last.at,
    ...(finalResult(events) ?? {}),
  };
}

/**
 * The ID the next attempt at `stepId` gets, such as `003-implement` (#15).
 *
 * The number counts attempts across the whole run, starting at 1, in start
 * order, so it is derived from the log rather than kept in memory: a resume
 * after a crash continues the count instead of restarting it and making a new
 * attempt that would write over an earlier one's folder.
 *
 * Zero-padded to three digits and widening past 999 (`1000-fix`). Nothing
 * sorts these strings — run order comes from the event log.
 */
export function nextAttemptId(state: RunState, stepId: StepId): AttemptId {
  const started = Object.values(state.attempts).reduce((total, ids) => total + ids.length, 0);
  return `${String(started + 1).padStart(3, "0")}-${stepId}`;
}

function stepNow(events: readonly RunEvent[]): StepId | undefined {
  let step: StepId | undefined;
  for (const event of events) {
    if (event.type === "attempt.started") step = event.stepId;
    else if (event.type === "transition" && !isEndState(event.to)) step = event.to;
  }
  return step;
}

/**
 * Counts in a `Map`, not in a plain object.
 *
 * `NAME_PATTERN` allows a step ID such as `constructor` or `toString`, and on a
 * plain object `counts[stepId] ?? 0` reads `Object.prototype`'s member instead
 * of zero for those. The count would then start from a function rather than
 * from one, and every reader of it — `maxAttempts`, the next attempt's number —
 * would carry the mistake on.
 */
function attemptsPerStep(events: readonly RunEvent[]): Record<StepId, readonly AttemptId[]> {
  const attempts = new Map<StepId, AttemptId[]>();
  for (const event of events) {
    if (event.type === "attempt.started") {
      const ids = attempts.get(event.stepId);
      if (ids) ids.push(event.attemptId);
      else attempts.set(event.stepId, [event.attemptId]);
    }
  }
  return Object.fromEntries(attempts);
}

/** Every `transition` event, oldest first, minus its envelope. */
function transitionRecords(events: readonly RunEvent[]): readonly TransitionRecord[] {
  return events
    .filter((event): event is Transition => event.type === "transition")
    .map(({ seq: _seq, at: _at, type: _type, ...record }) => record);
}

/**
 * Sums each run owner's time: from its `owner.started` to the last event it
 * wrote. The next `owner.started` closes the one before it, so a crash charges
 * the run only up to the last thing that owner managed to write.
 */
function ownerTimeMs(events: readonly RunEvent[]): number {
  return ownerTime(events, undefined);
}

function ownerTimeSinceContinueMs(events: readonly RunEvent[]): number {
  const index = lastContinuationIndex(events);
  if (index < 0) return ownerTimeMs(events);
  const continued = events[index];
  return continued === undefined ? 0 : ownerTime(events.slice(index + 1), Date.parse(continued.at));
}

function ownerTime(events: readonly RunEvent[], initialStart: number | undefined): number {
  let total = 0;
  let startedAt = initialStart;
  let lastAt = initialStart ?? 0;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.type === "owner.started") {
      total += span(startedAt, lastAt);
      startedAt = at;
    }
    lastAt = at;
  }
  return total + span(startedAt, lastAt);
}

function lastContinuationIndex(events: readonly RunEvent[]): number {
  return events.findLastIndex((event) => event.type === "run.continued");
}

function span(startedAt: number | undefined, lastAt: number): number {
  return startedAt === undefined ? 0 : lastAt - startedAt;
}

function finalResult(events: readonly RunEvent[]): { result: RunResult } | undefined {
  const end = events.findLast(isRunEnd);
  if (end === undefined || takenUpAgain(events, end)) return undefined;
  return { result: resultOf(end) };
}

function isRunEnd(event: RunEvent): event is RunEnded | RunCancelled {
  return event.type === "run.ended" || event.type === "run.cancelled";
}

/** True when `continue` or `resume` started the run again after `end`. */
function takenUpAgain(events: readonly RunEvent[], end: RunEnded | RunCancelled): boolean {
  return (
    lastContinuationIndex(events) > events.lastIndexOf(end) ||
    resumedAfterInternalError(events, end)
  );
}

function resultOf(end: RunEnded | RunCancelled): RunResult {
  return end.type === "run.cancelled"
    ? { result: "cancelled" }
    : { result: end.result, reason: end.reason };
}

function resumedAfterInternalError(
  events: readonly RunEvent[],
  end: RunEnded | RunCancelled,
): boolean {
  if (end.type !== "run.ended" || end.reason !== "internal_error") return false;
  const index = events.findLastIndex(
    (event) => event.type === "run.ended" && event.reason === "internal_error",
  );
  return events.slice(index + 1).some((event) => event.type === "owner.started");
}
