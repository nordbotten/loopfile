import type { InputSet, LoopEndReason, LoopSource } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import type { LoopStatus } from "../domain/status.ts";
import { checkAgainstDeclared, type InputsCheck, mergeInputSet } from "./launch-inputs.ts";

/** The state a loop driver can observe for its latest child. */
export type LastChildState = "none" | "running" | "completed" | "failed" | "cancelled" | "crashed";

/** The latest child run, or the absence of one. */
export type LastChild =
  | { readonly state: "none" }
  | { readonly state: Exclude<LastChildState, "none">; readonly runId: string };

/** The next deterministic move for a loop driver. */
export type LoopAction =
  | {
      readonly kind: "start";
      readonly inputSet: InputSet;
      readonly sourceIndex: number | null;
      readonly retryOf?: string;
    }
  | { readonly kind: "wait" }
  | { readonly kind: "end"; readonly reason: LoopEndReason; readonly detail?: string };

/** The parsed stdout result of one `--next` command. */
export type NextSourceResult =
  | { readonly kind: "empty" }
  | { readonly kind: "output"; readonly result: InputsCheck };

/** Chooses the next loop action from its status, child and materialized source. */
export function nextLoopAction(
  status: LoopStatus,
  lastChild: LastChild,
  source?: LoopSource,
  nextResult?: NextSourceResult,
  workflow?: Pick<Workflow, "inputs" | "inputDefaults">,
): LoopAction {
  if (lastChild.state === "running") return { kind: "wait" };
  const failed = failedChildAction(status, lastChild);
  if (failed !== undefined) return failed;
  const childEnd = childEndAction(lastChild);
  if (childEnd !== undefined) return childEnd;
  return uncappedSourceAction(status, source, nextResult, workflow);
}

function failedChildAction(status: LoopStatus, child: LastChild): LoopAction | undefined {
  if (child.state !== "failed") return undefined;
  if (status.lastRetryCount >= status.retry) {
    return { kind: "end", reason: "run_failed", detail: `run ${child.runId} failed` };
  }
  if (atRunCap(status)) return { kind: "end", reason: "max_runs" };
  return {
    kind: "start",
    inputSet: status.lastInputSet ?? status.fixedInputs,
    sourceIndex: status.lastSourceIndex,
    retryOf: child.runId,
  };
}

function uncappedSourceAction(
  status: LoopStatus,
  source: LoopSource | undefined,
  nextResult: NextSourceResult | undefined,
  workflow: Pick<Workflow, "inputs" | "inputDefaults"> | undefined,
): LoopAction {
  if (atRunCap(status)) return { kind: "end", reason: "max_runs" };
  if (source?.kind === "next") return nextCommandAction(status, nextResult, workflow);
  return source?.kind === "list" ? nextListAction(status, source) : nextTimesAction(status);
}

function atRunCap(status: LoopStatus): boolean {
  return status.maxRuns !== null && status.runs >= status.maxRuns;
}

function childEndAction(child: LastChild): LoopAction | undefined {
  if (child.state === "cancelled") {
    return { kind: "end", reason: "run_failed", detail: `run ${child.runId} cancelled` };
  }
  if (child.state === "crashed") {
    return { kind: "end", reason: "internal_error", detail: `child run ${child.runId} crashed` };
  }
  return undefined;
}

function nextCommandAction(
  status: LoopStatus,
  result: NextSourceResult | undefined,
  workflow: Pick<Workflow, "inputs" | "inputDefaults"> | undefined,
): LoopAction {
  if (result === undefined) {
    return { kind: "end", reason: "source_failed", detail: "--next did not produce a result" };
  }
  if (result.kind === "empty") return { kind: "end", reason: "source_empty" };
  if (!result.result.ok) {
    return { kind: "end", reason: "source_failed", detail: result.result.messages.join("; ") };
  }
  const merged = mergeInputSet(status.fixedInputs, result.result.inputs);
  if (!merged.ok) {
    return { kind: "end", reason: "source_failed", detail: merged.messages.join("; ") };
  }
  const checked = checkAgainstDeclared(
    merged.inputs,
    workflow?.inputs ?? {},
    workflow?.inputDefaults,
  );
  if (!checked.ok) {
    return { kind: "end", reason: "source_failed", detail: checked.messages.join("; ") };
  }
  return { kind: "start", inputSet: checked.inputs, sourceIndex: null };
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
