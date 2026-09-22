/**
 * The pure rules of resuming a crashed run (#64, ADR 0003, ADR 0006).
 *
 * Resume goes on from the last complete state in the event log. It never
 * continues an attempt that has a start and no end: that attempt gets
 * `attempt.interrupted`, and the step gets a new attempt from the beginning.
 * The command and the run owner do the IO; this file says whether a run may be
 * resumed and where it goes on from.
 */

import {
  type AttemptStarted,
  EVENT_FORMAT_VERSION,
  type RunCreated,
  type RunEvent,
} from "../domain/events.ts";
import { type EndState, isEndState, type StepId, type Workflow } from "../domain/model.ts";
import { type RunState, replay } from "./replay.ts";
import type { AttemptEndFields } from "./workflow-run.ts";

/** Where a resumed run goes on from. */
export type ResumeNext =
  /** Start a new attempt of this step, once its `maxAttempts` allows it. */
  | { readonly kind: "step"; readonly stepId: StepId }
  /** The attempt ended but its transition was never written: route it now. */
  | {
      readonly kind: "route";
      readonly stepId: StepId;
      readonly attemptId: string;
      readonly end: AttemptEndFields;
    }
  /** The run moved to an end state but `run.ended` was never written. */
  | { readonly kind: "end"; readonly state: EndState };

export interface ResumePlan {
  /** The attempt with a start and no end. It gets `attempt.interrupted`. */
  readonly interrupted?: AttemptStarted;
  /**
   * The process group that can outlive the interrupted attempt: the attempt's
   * own, or for a Ralph attempt the group of its last started iteration. 0 is
   * no group. Set only with `interrupted`.
   */
  readonly leftoverGroup?: number;
  readonly next: ResumeNext;
}

/**
 * Why the run in `events` may not be resumed with a model of `modelDigest`, or
 * nothing when it may. A run that ended or was cancelled is not crashed, except
 * an `internal_error` run gets one resume. A changed model or an event format
 * this tool cannot read would run a different workflow than the one the log
 * records. No flag skips this (ADR 0006).
 */
export function resumeRefusal(
  events: readonly RunEvent[],
  modelDigest: string,
): string | undefined {
  const state = replay(events);
  const created = events[0] as RunCreated;
  const ended = endedRefusal(state, events);
  if (ended !== undefined) return ended;
  if (created.eventFormatVersion !== EVENT_FORMAT_VERSION) {
    return (
      `run ${state.runId} has event format version ${created.eventFormatVersion}, ` +
      `and this loopfile reads only version ${EVENT_FORMAT_VERSION}.`
    );
  }
  if (state.modelDigest !== modelDigest) {
    return (
      `the Materialized Loopfile of run ${state.runId} no longer builds the model the run started with.\n` +
      `  run.created model digest: ${state.modelDigest}\n` +
      `  model digest now:         ${modelDigest}`
    );
  }
  return undefined;
}

/** Refuse every terminal result except an `internal_error` not repeated without an attempt. */
function endedRefusal(state: RunState, events: readonly RunEvent[]): string | undefined {
  const { result } = state;
  if (result === undefined) return undefined;
  if (
    result.result !== "cancelled" &&
    result.reason === "internal_error" &&
    !secondInternalErrorWithoutAttempt(events)
  ) {
    return undefined;
  }
  const how = result.result === "cancelled" ? "was cancelled" : `has ended (${result.result})`;
  return `run ${state.runId} ${how}. Resume is only for a crashed run: start a new run instead.`;
}

/** True when an `internal_error` ended two owners without an attempt between them. */
function secondInternalErrorWithoutAttempt(events: readonly RunEvent[]): boolean {
  let internalErrorSinceAttempt = false;
  for (const event of events) {
    if (event.type === "attempt.started") internalErrorSinceAttempt = false;
    if (event.type === "run.ended" && event.reason === "internal_error") {
      if (internalErrorSinceAttempt) return true;
      internalErrorSinceAttempt = true;
    }
  }
  return false;
}

/**
 * Where a crashed run goes on from, read off the end of its log: the last
 * attempt start, attempt end, interrupt or transition says what was done last.
 * A run with no attempt yet starts at the entry step.
 */
export function resumePlan(workflow: Workflow, events: readonly RunEvent[]): ResumePlan {
  let next: ResumeNext = { kind: "step", stepId: workflow.steps[0]?.id ?? "" };
  const stepOf = new Map<string, StepId>();
  for (const event of events) {
    if (event.type === "attempt.started") stepOf.set(event.attemptId, event.stepId);
    next = nextAfter(next, event, stepOf);
  }
  return { ...openAttempt(events), next };
}

/** The attempt with a start and no end, and the group that can outlive it. */
function openAttempt(
  events: readonly RunEvent[],
): { interrupted: AttemptStarted; leftoverGroup: number } | undefined {
  let open: { interrupted: AttemptStarted; leftoverGroup: number } | undefined;
  for (const event of events) {
    if (event.type === "attempt.started") {
      open = { interrupted: event, leftoverGroup: event.processGroupId };
    } else if (event.type === "iteration.started") {
      // An iteration only ever belongs to the open attempt.
      open &&= { ...open, leftoverGroup: event.processGroupId };
    } else if (event.type === "attempt.ended" || event.type === "attempt.interrupted") {
      open = undefined;
    }
  }
  return open;
}

/** Where the run goes on from once `event` is done. An interrupt changes nothing. */
function nextAfter(next: ResumeNext, event: RunEvent, stepOf: Map<string, StepId>): ResumeNext {
  switch (event.type) {
    case "attempt.started":
      return { kind: "step", stepId: event.stepId };
    case "attempt.ended": {
      const { seq: _seq, at: _at, type: _type, attemptId, ...end } = event;
      return { kind: "route", stepId: stepOf.get(attemptId) ?? "", attemptId, end };
    }
    case "transition":
      return isEndState(event.to)
        ? { kind: "end", state: event.to }
        : { kind: "step", stepId: event.to };
    default:
      return next;
  }
}
