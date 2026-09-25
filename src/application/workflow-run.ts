/**
 * The pure rules of running a workflow start to end (#116): how an attempt
 * ends, and how a run ends.
 *
 * The run owner's loop is in `adapters/workflow-run.ts`. It does the IO and
 * asks this file what each fact means, so no decision about routing or ends
 * hides in code that touches a process or a file.
 */

import { createHash } from "node:crypto";
import type { AttemptEnded, RunEnded, RunEvent } from "../domain/events.ts";
import type { AttemptId, EndState, Step, Workflow } from "../domain/model.ts";
import { classifyAgentEnd, reportedOutcome } from "./agent-step.ts";
import type { Ended } from "./executor.ts";
import { checkOutputs } from "./output-check.ts";

/** What `attempt.ended` says beyond its envelope and the attempt ID. */
export type AttemptEndFields = Pick<
  AttemptEnded,
  "result" | "reason" | "outcome" | "output" | "field" | "value"
>;

/**
 * How a finished attempt of `step` ended: the exit and the reported outcome
 * (ADR 0005), then the outputs the step declared. A required output that was
 * never put fails an attempt that would otherwise have succeeded.
 */
export function endOfAttempt(
  step: Step,
  history: readonly RunEvent[],
  attemptId: AttemptId,
  exit: Ended,
): AttemptEndFields {
  const end = classifyAgentEnd(step, exit, reportedOutcome(history, attemptId));
  const outcome = end.outcome === undefined ? {} : { outcome: end.outcome };
  if (end.result === "failure") return { result: "failure", reason: end.reason, ...outcome };
  const check = checkOutputs(step, history, attemptId, end.outcome);
  if (!check.allowed) {
    return { result: "failure", reason: "missing_output", output: check.output, ...outcome };
  }
  return { result: "success", reason: end.reason, ...outcome };
}

/** The end of an attempt whose process never started. */
export const START_FAILED_END: AttemptEndFields = { result: "failure", reason: "start_failed" };

/** The `run.ended` event for a transition to an end state. */
export function endStateEvent(state: EndState): Omit<RunEnded, "seq" | "at"> {
  return {
    type: "run.ended",
    result: state === "$success" ? "success" : "failure",
    reason: "end_state",
  };
}

/**
 * The digest of the built model that `run.created` records and resume checks
 * (ADR 0006). The model is plain JSON-serializable data (ADR 0002), so its JSON
 * text is stable.
 */
export function modelDigest(workflow: Workflow): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}
