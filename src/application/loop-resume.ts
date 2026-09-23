import type { LoopEvent } from "../domain/events.ts";

/** Whether an internal-error loop end repeats without a new run or child progress. */
export function repeatedLoopInternalError(events: readonly LoopEvent[]): boolean {
  let childSequences = new Set<number | null | undefined>();
  for (const event of events) {
    if (event.type === "loop.run_started") childSequences = new Set();
    if (event.type !== "loop.ended" || event.reason !== "internal_error") continue;
    if (childSequences.has(event.childSeq)) return true;
    childSequences.add(event.childSeq);
  }
  return false;
}
