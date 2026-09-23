/** The pure rules for continuing an ended run (#85, ADR 0003, ADR 0006). */

import type { RunCreated, RunEnded, RunEvent } from "../domain/events.ts";
import { isEndState, type StepId, type Workflow } from "../domain/model.ts";
import { isCompleted, isInternalError, replay } from "./replay.ts";
import { resumePlan, runModelRefusal } from "./resume.ts";
import type { AttemptEndFields } from "./workflow-run.ts";

export type ContinueNext =
  | { readonly kind: "step"; readonly stepId: StepId }
  | {
      readonly kind: "route";
      readonly stepId: StepId;
      readonly attemptId: string;
      readonly end: AttemptEndFields;
    };

/** Why an ended run may not be continued with this Materialized Loopfile. */
export function continueRefusal(
  events: readonly RunEvent[],
  modelDigest: string,
): string | undefined {
  const state = replay(events);
  const result = state.result;
  if (result === undefined) {
    return `run ${state.runId} is crashed. Resume it with \`loopfile resume ${state.runId}\`.`;
  }
  if (isInternalError(result)) {
    return `run ${state.runId} ended with internal_error. Resume it with \`loopfile resume ${state.runId}\`.`;
  }
  if (isCompleted(result)) {
    return `run ${state.runId} completed and cannot be continued. Start a new run instead.`;
  }
  const created = events[0] as RunCreated;
  if (created.loopId !== undefined) {
    return `run ${state.runId} is a child of loop ${created.loopId} and cannot be continued individually.`;
  }
  return runModelRefusal(events, modelDigest);
}

/** The step to retry, or the last attempt result whose refused move should be taken. */
export function continuePlan(workflow: Workflow, events: readonly RunEvent[]): ContinueNext {
  const stepId = endedStep(events);
  if (stepId !== undefined) return { kind: "step", stepId };
  const next = resumePlan(workflow, events).next;
  if (next.kind === "step" || next.kind === "route") return next;
  throw new Error("the ended run has no stopped step to continue");
}

/** The step a `run.ended` points at: the step at its attempt limit, or the step whose outcome went to `$failure`. */
function endedStep(events: readonly RunEvent[]): StepId | undefined {
  const terminal = events.findLast(
    (event) => event.type === "run.ended" || event.type === "run.cancelled",
  );
  return terminal?.type === "run.ended" ? stepOfEnd(terminal, events) : undefined;
}

function stepOfEnd(end: RunEnded, events: readonly RunEvent[]): StepId | undefined {
  switch (end.reason) {
    case "internal_error":
      throw new Error("internal_error runs must be resumed");
    case "attempt_limit":
      if (end.stepId === undefined) throw new Error("attempt_limit is missing its step ID");
      return end.stepId;
    case "end_state":
      return endStateStep(events);
    default:
      return undefined;
  }
}

/** The step whose move to an end state ended the run. */
function endStateStep(events: readonly RunEvent[]): StepId {
  const transition = events.findLast(
    (event) => event.type === "transition" && isEndState(event.to),
  );
  if (transition?.type !== "transition") throw new Error("end_state is missing its transition");
  return transition.from;
}
