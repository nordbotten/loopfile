/** The pure rules for continuing an ended run (#85, ADR 0003, ADR 0006). */

import type { RunCreated, RunEvent } from "../domain/events.ts";
import { isEndState, type StepId, type Workflow } from "../domain/model.ts";
import { replay } from "./replay.ts";
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
  if (result.result === "failure" && result.reason === "internal_error") {
    return `run ${state.runId} ended with internal_error. Resume it with \`loopfile resume ${state.runId}\`.`;
  }
  if (result.result === "success" && result.reason === "end_state") {
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
  const terminal = events.findLast(
    (event) => event.type === "run.ended" || event.type === "run.cancelled",
  );
  if (terminal?.type === "run.ended" && terminal.reason === "internal_error") {
    throw new Error("internal_error runs must be resumed");
  }
  if (terminal?.type === "run.ended" && terminal.reason === "attempt_limit") {
    if (terminal.stepId === undefined) throw new Error("attempt_limit is missing its step ID");
    return { kind: "step", stepId: terminal.stepId };
  }
  if (terminal?.type === "run.ended" && terminal.reason === "end_state") {
    const transition = events.findLast(
      (event) => event.type === "transition" && isEndState(event.to),
    );
    if (transition?.type !== "transition") throw new Error("end_state is missing its transition");
    return { kind: "step", stepId: transition.from };
  }

  const next = resumePlan(workflow, events).next;
  if (next.kind === "step" || next.kind === "route") return next;
  throw new Error("the ended run has no stopped step to continue");
}
