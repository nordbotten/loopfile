/**
 * Whether a step may start another attempt, or must end the run instead (#29).
 *
 * A step's attempt count is per step since the last `run.continued` (ADR 0003):
 * `RunState.attemptsSinceContinue` carries every attempt ID in that limit
 * window, including interrupted ones, so its length is the count. This
 * check reads that count before a new attempt starts. It is not routing:
 * hitting the limit ends the run in failure before the attempt runs, and
 * never takes `onFailure` (`docs/manifest-v1.md#limits`).
 */

import type { RunEnded } from "../domain/events.ts";
import type { Step } from "../domain/model.ts";
import type { RunState } from "./replay.ts";

/** The run.ended event to append, envelope fields left for the caller to fill in. */
export type RunEndedFields = Omit<RunEnded, "seq" | "at">;

/** Whether the step may start another attempt. */
export type AttemptLimitCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly event: RunEndedFields };

/** Checks `step`'s attempt count against its `maxAttempts` before an attempt starts. */
export function checkAttemptLimit(step: Step, state: RunState): AttemptLimitCheck {
  // Own key only: a step ID such as `constructor` would otherwise read an
  // inherited `Object.prototype` member (see replay.ts).
  const own = Object.hasOwn(state.attemptsSinceContinue, step.id)
    ? state.attemptsSinceContinue[step.id]
    : undefined;
  const attempts = own?.length ?? 0;
  if (attempts < step.maxAttempts) return { allowed: true };
  return {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "attempt_limit", stepId: step.id },
  };
}
