/**
 * Deterministic routing: which step the run goes to when an attempt ends (#27).
 *
 * Routing is pure runtime code over the normalized model (ADR 0002). It reads
 * no YAML, and no LLM takes part: the same attempt result on the same step
 * always picks the same target.
 *
 * An exit status never picks a route. It only says whether the attempt ended
 * cleanly, which the caller has already decided by the time it gets here, so
 * routing reads the `attempt.ended` fields and nothing else:
 *
 * - success on an `outcome` goes to `on[outcome]`.
 * - success on a `clean_exit` goes to the next step in the list, and past the
 *   last step the run ends in success.
 * - any failure goes to the step's `onFailure`, which the loader fills in with
 *   `$failure`. It never goes to the next step.
 *
 * Limits are not routing: `maxAttempts` and `maxTransitions` end the run
 * before an attempt starts, and neither takes `onFailure`.
 */

import type { AttemptEnded, Transition, TransitionCause } from "../domain/events.ts";
import type { AttemptId, Outcome, Step, StepId, Target, Workflow } from "../domain/model.ts";

/** The part of `attempt.ended` that routing reads. */
export interface AttemptResult {
  readonly result: AttemptEnded["result"];
  readonly reason: AttemptEnded["reason"];
  readonly outcome?: Outcome;
}

/** Where the run goes next, and what took it there. */
export interface Route {
  readonly to: Target;
  readonly cause: TransitionCause;
}

/**
 * Thrown when the attempt result and the step do not fit together: a step ID
 * the workflow does not have, a reported outcome the step's `on` does not
 * name, or a clean exit with no outcome on a step that names outcomes. The
 * last two are failed attempts, so a caller that reaches routing with them as
 * a success has classified the attempt wrongly, and there is no target to
 * pick.
 */
export class UnroutableAttemptError extends Error {}

/** Picks the next target for the step whose attempt just ended. */
export function route(workflow: Workflow, stepId: StepId, attempt: AttemptResult): Route {
  const index = workflow.steps.findIndex((step) => step.id === stepId);
  const step = workflow.steps[index];
  if (step === undefined) {
    throw new UnroutableAttemptError(`the workflow has no step ${stepId}`);
  }
  if (attempt.result === "failure") {
    return { to: step.onFailure, cause: "onFailure" };
  }
  return successRoute(workflow, index, step, attempt);
}

/** The route of an attempt that ended in success: its outcome, or the next step. */
function successRoute(
  workflow: Workflow,
  index: number,
  step: Step,
  attempt: AttemptResult,
): Route {
  const stepId = step.id;
  if (attempt.reason === "outcome") {
    return { to: outcomeTarget(step, attempt.outcome), cause: "on" };
  }
  if (attempt.reason !== "clean_exit") {
    throw new UnroutableAttemptError(
      `step ${stepId} cannot end in success with the reason ${attempt.reason}`,
    );
  }
  if (Object.keys(step.on).length > 0) {
    throw new UnroutableAttemptError(
      `step ${stepId} names outcomes, so a clean exit without one fails the attempt`,
    );
  }
  return { to: workflow.steps[index + 1]?.id ?? "$success", cause: "next" };
}

/**
 * The `transition` event for the attempt that just ended (#28), minus the
 * envelope fields the event log fills in on append.
 *
 * Built from the same `AttemptResult` `route` reads, so the event and the
 * routing decision it records can never disagree.
 */
export function transitionEvent(
  workflow: Workflow,
  stepId: StepId,
  attemptId: AttemptId,
  attempt: AttemptResult,
): Omit<Transition, "seq" | "at"> {
  const { to, cause } = route(workflow, stepId, attempt);
  return {
    type: "transition",
    from: stepId,
    attemptId,
    result: attempt.result,
    reason: attempt.reason,
    ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
    to,
    cause,
  };
}

/**
 * The target a reported outcome takes.
 *
 * The lookup asks for the step's own key, because `on` is plain data and a
 * `Object.prototype` name such as `constructor` matches `NAME_PATTERN`. An
 * outcome a step does not declare is a failed attempt, never a route.
 */
function outcomeTarget(step: Step, outcome: Outcome | undefined): Target {
  const to =
    outcome !== undefined && Object.hasOwn(step.on, outcome) ? step.on[outcome] : undefined;
  if (to === undefined) {
    throw new UnroutableAttemptError(`step ${step.id} has no route for the outcome ${outcome}`);
  }
  return to;
}
