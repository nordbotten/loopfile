/**
 * The two run-wide limits from the workflow model: `maxTransitions` and
 * `runTimeoutMs` (#30, decided in #73, changed by #76).
 *
 * Both are optional with no default: left out means no limit. Neither is
 * routing (`routing.ts`) — a limit ends the run before the next move is
 * taken, and never takes `onFailure`. These functions are pure: the caller
 * supplies the counts already read from `RunState`, so this file never reads
 * a clock or a file.
 */

import type { RunEnded } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";

/** A `run.ended` event, minus the envelope fields the event log fills in on append. */
export type RunEndedFields = Omit<RunEnded, "seq" | "at">;

/** Whether a run-wide limit lets the next move happen. */
export type LimitCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly event: RunEndedFields };

/**
 * Checks `maxTransitions` before a move is taken.
 *
 * A transition is any move: an `on` route, `onFailure`, or falling through to
 * the next step, including a move to `$success` or `$failure`. `state`'s
 * transition count is the number already taken. The move that would make the
 * count go past `maxTransitions` is refused; a count that lands exactly on
 * `maxTransitions` is allowed, so a run may still end normally on its last
 * allowed move.
 */
export function checkTransitionLimit(workflow: Workflow, transitionCount: number): LimitCheck {
  if (workflow.maxTransitions === undefined) return { allowed: true };
  if (transitionCount < workflow.maxTransitions) return { allowed: true };
  return {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "transition_limit" },
  };
}

/**
 * Checks `runTimeoutMs` against the run owner time used so far.
 *
 * `ownerTimeMs` counts only run owner wall time, from each `owner.started` to
 * that owner's last event (`replay`'s `ownerTimeMs`), so the gap between a
 * crash and its resume is never charged to the run.
 */
export function checkRunTimeout(workflow: Workflow, ownerTimeMs: number): LimitCheck {
  if (workflow.runTimeoutMs === undefined) return { allowed: true };
  if (ownerTimeMs < workflow.runTimeoutMs) return { allowed: true };
  return {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "run_timeout" },
  };
}
