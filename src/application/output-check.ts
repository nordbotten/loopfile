/**
 * Whether an attempt that would otherwise end cleanly has put every output its
 * step declares as required (#22, decided in #72).
 *
 * Declared outputs are checked as required data keys at attempt end, not
 * collected from a folder (ADR 0005). A step's `outputs` maps each output
 * name to the outcomes that require it; an empty list is the manifest's list
 * form, required on every clean exit. Only a put made by this attempt counts:
 * `putsBy` already scopes to one attempt ID, and a Ralph step keeps one
 * attempt ID across its iterations (ADR 0005), so a put by any iteration of
 * this attempt counts. This check is not routing and does not run for an
 * attempt that has already failed for another reason; the caller decides
 * that before calling here.
 */

import type { RunEvent } from "../domain/events.ts";
import type { AttemptId, Outcome, OutputName, Step } from "../domain/model.ts";
import { putsBy } from "./data-store.ts";

/** Whether the attempt put every output its step requires for this end. */
export type OutputCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly output: OutputName };

/**
 * Checks `step`'s declared outputs against what `attemptId` has put.
 *
 * `outcome` is the outcome the attempt is ending on, or nothing for a clean
 * exit with no outcome. An output required by a list of outcomes counts only
 * when `outcome` is one of them; the list form (an empty array) always
 * counts. When more than one output is missing, the first in declaration
 * order is reported, because `attempt.ended` names only one key.
 */
export function checkOutputs(
  step: Step,
  events: readonly RunEvent[],
  attemptId: AttemptId,
  outcome: Outcome | undefined,
): OutputCheck {
  const puts = putsBy(events, attemptId);
  for (const [name, outcomes] of Object.entries(step.outputs)) {
    const required = outcomes.length === 0 || (outcome !== undefined && outcomes.includes(outcome));
    if (required && !puts.has(`${step.id}.${name}`)) {
      return { allowed: false, output: name };
    }
  }
  return { allowed: true };
}
