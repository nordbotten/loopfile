/**
 * A Ralph step's rules: how one iteration ends, and what that means for the
 * attempt (ADR 0005, #33).
 *
 * An iteration is one harness call. Only a clean exit with a reported outcome
 * ends the attempt. Every other end starts a fresh iteration, until
 * `maxIterations` is hit and the attempt fails with `iteration_limit`.
 */

import type { AttemptEnded, IterationEndReason, RunEvent } from "../domain/events.ts";
import type { AttemptId, Outcome, RalphStep } from "../domain/model.ts";
import { commandEndReason } from "./command-step.ts";
import type { Ended } from "./executor.ts";

/** The last outcome one iteration reported, or nothing. */
export function iterationOutcome(
  history: readonly RunEvent[],
  attemptId: AttemptId,
  iteration: number,
): Outcome | undefined {
  let found: Outcome | undefined;
  for (const event of history) {
    if (
      event.type === "outcome.reported" &&
      event.attemptId === attemptId &&
      event.iteration === iteration
    ) {
      found = event.outcome;
    }
  }
  return found;
}

/**
 * Why an iteration stopped. A timeout wins over the exit it caused, and a bad
 * exit wins over an outcome: that outcome is ignored.
 */
export function classifyIteration(
  exit: Ended,
  timedOut: boolean,
  outcome: Outcome | undefined,
): IterationEndReason {
  if (timedOut) return "timeout";
  if (commandEndReason(exit) === "nonzero_exit") return "nonzero_exit";
  return outcome === undefined ? "no_outcome" : "outcome";
}

/** What ends the attempt: the reported outcome, or the iteration limit. */
export interface RalphAttemptEnd {
  readonly result: AttemptEnded["result"];
  readonly reason: AttemptEnded["reason"];
  readonly outcome?: Outcome;
  readonly field?: AttemptEnded["field"];
  readonly value?: AttemptEnded["value"];
}

/** The end of an attempt whose iteration reported `outcome` and exited 0. */
export function outcomeEnd(step: RalphStep, outcome: Outcome): RalphAttemptEnd {
  return Object.hasOwn(step.on, outcome)
    ? { result: "success", reason: "outcome", outcome }
    : { result: "failure", reason: "outcome_not_allowed", outcome };
}

/** The end of an attempt that used all its iterations without an outcome. */
export const ITERATION_LIMIT_END: RalphAttemptEnd = {
  result: "failure",
  reason: "iteration_limit",
};
