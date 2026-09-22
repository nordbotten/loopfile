import type { InputSet, LoopEndReason } from "../domain/events.ts";
import type { LoopStatus } from "../domain/status.ts";

/** The state a loop driver can observe for its latest child. */
export type LastChildState = "none" | "running" | "completed" | "failed" | "cancelled" | "crashed";

/** The latest child run, or the absence of one. */
export type LastChild =
  | { readonly state: "none" }
  | { readonly state: Exclude<LastChildState, "none">; readonly runId: string };

/** The next deterministic move for a loop driver. */
export type LoopAction =
  | { readonly kind: "start"; readonly inputSet: InputSet; readonly sourceIndex: number }
  | { readonly kind: "wait" }
  | { readonly kind: "end"; readonly reason: LoopEndReason; readonly detail?: string };

/** Chooses the next default `--times` loop action from its status and child. */
export function nextLoopAction(status: LoopStatus, lastChild: LastChild): LoopAction {
  if (lastChild.state === "running") return { kind: "wait" };
  if (lastChild.state === "failed" || lastChild.state === "cancelled") {
    return {
      kind: "end",
      reason: "run_failed",
      detail: `run ${lastChild.runId} ${lastChild.state}`,
    };
  }
  if (lastChild.state === "crashed") {
    return {
      kind: "end",
      reason: "internal_error",
      detail: `child run ${lastChild.runId} crashed`,
    };
  }

  const count = "count" in status.source ? status.source.count : 0;
  if (status.place !== null && status.place < count) {
    return {
      kind: "start",
      inputSet: status.fixedInputs,
      sourceIndex: status.place + 1,
    };
  }
  return { kind: "end", reason: "source_empty" };
}
