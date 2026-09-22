/**
 * An agent step's end: what the process did and what the agent reported are
 * two facts, and only the second picks a route (ADR 0005, #25).
 *
 * The outcome comes only from `loopfile result`, which the run owner records
 * as an `outcome.reported` event. Harness output is never read for one. How
 * the process exited says only whether the attempt ended cleanly.
 */

import type { AttemptEnded, RunEvent } from "../domain/events.ts";
import type { AttemptId, Outcome, Step } from "../domain/model.ts";
import { commandEndReason } from "./command-step.ts";
import type { Ended } from "./executor.ts";

/** How an agent attempt ended: the exit status and the outcome, kept apart. */
export interface AgentEnd {
  readonly exit: Ended;
  readonly outcome?: Outcome;
  readonly result: AttemptEnded["result"];
  readonly reason: AttemptEnded["reason"];
}

/** The last outcome this attempt reported, or nothing. */
export function reportedOutcome(
  history: readonly RunEvent[],
  attemptId: AttemptId,
): Outcome | undefined {
  let found: Outcome | undefined;
  for (const event of history) {
    if (event.type === "outcome.reported" && event.attemptId === attemptId) {
      found = event.outcome;
    }
  }
  return found;
}

/**
 * Classifies a finished agent attempt.
 *
 * - A non-zero exit or a signal fails the attempt, whatever was reported.
 * - A clean exit with an outcome that is a key of `on` succeeds on it.
 * - A clean exit with an outcome that is not a key of `on` fails.
 * - A clean exit with no outcome fails when the step has an `on` map.
 */
export function classifyAgentEnd(
  step: Pick<Step, "on">,
  exit: Ended,
  outcome: Outcome | undefined,
): AgentEnd {
  const base = outcome === undefined ? { exit } : { exit, outcome };
  if (commandEndReason(exit) === "nonzero_exit") {
    return { ...base, result: "failure", reason: "nonzero_exit" };
  }
  if (outcome === undefined) {
    const hasOutcomes = Object.keys(step.on).length > 0;
    return { ...base, result: hasOutcomes ? "failure" : "success", reason: "clean_exit" };
  }
  if (!Object.hasOwn(step.on, outcome)) {
    return { ...base, result: "failure", reason: "outcome_not_allowed" };
  }
  return { ...base, result: "success", reason: "outcome" };
}
