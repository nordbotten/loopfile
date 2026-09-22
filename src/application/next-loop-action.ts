import type { InputSet, LoopEndReason, LoopSource } from "../domain/events.ts";
import type { LoopStatus } from "../domain/status.ts";
import { mergeInputSet } from "./launch-inputs.ts";

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

/** Chooses the next loop action from its status, child and materialized source. */
export function nextLoopAction(
  status: LoopStatus,
  lastChild: LastChild,
  source?: LoopSource,
): LoopAction {
  if (lastChild.state === "running") return { kind: "wait" };
  const childEnd = childEndAction(lastChild);
  if (childEnd !== undefined) return childEnd;
  return source?.kind === "list" ? nextListAction(status, source) : nextTimesAction(status);
}

function childEndAction(child: LastChild): LoopAction | undefined {
  if (child.state === "failed" || child.state === "cancelled") {
    return { kind: "end", reason: "run_failed", detail: `run ${child.runId} ${child.state}` };
  }
  if (child.state === "crashed") {
    return { kind: "end", reason: "internal_error", detail: `child run ${child.runId} crashed` };
  }
  return undefined;
}

function nextListAction(
  status: LoopStatus,
  source: Extract<LoopSource, { readonly kind: "list" }>,
): LoopAction {
  const place = status.place ?? 0;
  if (place >= source.sets.length) return { kind: "end", reason: "source_empty" };
  const merged = mergeInputSet(status.fixedInputs, source.sets[place] as InputSet);
  if (!merged.ok) {
    return { kind: "end", reason: "source_failed", detail: merged.messages.join("; ") };
  }
  return { kind: "start", inputSet: merged.inputs, sourceIndex: place + 1 };
}

function nextTimesAction(status: LoopStatus): LoopAction {
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
