import type {
  InputSet,
  LoopCancelMode,
  LoopEndReason,
  LoopEvent,
  LoopRunStarted,
  LoopSource,
} from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import type { LoopStatus } from "../domain/status.ts";
import { checkAgainstDeclared, type InputsCheck, mergeInputSet } from "./launch-inputs.ts";

/** The state a loop driver can observe for its latest child. */
export type LastChildState =
  | "none"
  | "running"
  | "not_started"
  | "completed"
  | "failed"
  | "internal_error"
  | "cancelled"
  | "crashed";

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
  | { readonly kind: "resume_child"; readonly runId: string }
  | { readonly kind: "start_pending"; readonly run: LoopRunStarted }
  | { readonly kind: "pause"; readonly until: string }
  | {
      readonly kind: "end";
      readonly reason: LoopEndReason;
      readonly detail?: string;
      readonly cancelMode?: LoopCancelMode;
    };

/** Options needed to decide whether the gap before the next run needs a pause. */
export interface NextLoopActionOptions {
  readonly pauseMs?: number | null;
  readonly now?: Date;
  readonly resumeCrashedChild?: boolean;
}

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
  history: readonly LoopEvent[] = [],
  options: NextLoopActionOptions = {},
): LoopAction {
  if (lastChild.state === "running") return { kind: "wait" };
  if (status.cancelRequested !== null) {
    return { kind: "end", reason: "cancelled", cancelMode: status.cancelRequested };
  }
  if (lastChild.state === "not_started") {
    const run = history.findLast(
      (event): event is LoopRunStarted =>
        event.type === "loop.run_started" && event.runId === lastChild.runId,
    );
    return run === undefined
      ? {
          kind: "end",
          reason: "internal_error",
          detail: `missing loop.run_started for ${lastChild.runId}`,
        }
      : { kind: "start_pending", run };
  }
  if (
    options.resumeCrashedChild &&
    (lastChild.state === "crashed" || lastChild.state === "internal_error")
  ) {
    return { kind: "resume_child", runId: lastChild.runId };
  }
  const actionOptions = optionsAfterRecordedPause(options, history);
  const failed = failedChildAction(status, lastChild, history, actionOptions);
  if (failed !== undefined) return failed;
  const childEnd = childEndAction(lastChild);
  if (childEnd !== undefined) return childEnd;
  return uncappedSourceAction(status, source, nextResult, workflow, actionOptions);
}

function failedChildAction(
  status: LoopStatus,
  child: LastChild,
  history: readonly LoopEvent[],
  options: NextLoopActionOptions,
): LoopAction | undefined {
  if (child.state !== "failed" && child.state !== "internal_error") return undefined;
  const details = retryDetails(child.runId, history);
  if (details === undefined || details.retriesSoFar >= status.retry) {
    return { kind: "end", reason: "run_failed", detail: `run ${child.runId} failed` };
  }
  if (atRunCap(status)) return { kind: "end", reason: "max_runs" };
  return withPause(
    status,
    {
      kind: "start",
      inputSet: details.run.inputSet,
      sourceIndex: details.run.sourceIndex,
      retryOf: child.runId,
    },
    options,
  );
}

type RetryDetails = { readonly run: LoopRunStarted; readonly retriesSoFar: number };

function retryDetails(runId: string, history: readonly LoopEvent[]): RetryDetails | undefined {
  const started = history.filter(
    (event): event is LoopRunStarted => event.type === "loop.run_started",
  );
  const run = started.findLast((event) => event.runId === runId);
  if (run === undefined) return undefined;

  const byId = new Map(started.map((event) => [event.runId, event]));
  let retriesSoFar = 0;
  let parentId = run.retryOf;
  while (parentId !== null) {
    retriesSoFar += 1;
    parentId = byId.get(parentId)?.retryOf ?? null;
  }
  return { run, retriesSoFar };
}

function uncappedSourceAction(
  status: LoopStatus,
  source: LoopSource | undefined,
  nextResult: NextSourceResult | undefined,
  workflow: Pick<Workflow, "inputs" | "inputDefaults"> | undefined,
  options: NextLoopActionOptions,
): LoopAction {
  if (atRunCap(status)) return { kind: "end", reason: "max_runs" };
  if (source?.kind === "next") return nextCommandAction(status, nextResult, workflow, options);
  const action = source?.kind === "list" ? nextListAction(status, source) : nextTimesAction(status);
  return withPause(status, action, options);
}

function atRunCap(status: LoopStatus): boolean {
  return status.maxRuns !== null && status.runs >= status.maxRuns;
}

function childEndAction(child: LastChild): LoopAction | undefined {
  if (child.state === "cancelled") {
    return { kind: "end", reason: "cancelled", detail: `run ${child.runId} cancelled` };
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
  options: NextLoopActionOptions,
): LoopAction {
  if (result === undefined) {
    return (
      pauseAction(status, options) ??
      ({ kind: "end", reason: "source_failed", detail: "--next did not produce a result" } as const)
    );
  }
  const checked = checkNextCommand(result, status, workflow);
  if (checked.kind === "end") return checked;
  return withPause(
    status,
    { kind: "start", inputSet: checked.inputSet, sourceIndex: null },
    options,
  );
}

type NextCommandCheck =
  | { readonly kind: "input"; readonly inputSet: InputSet }
  | Extract<LoopAction, { readonly kind: "end" }>;

function checkNextCommand(
  result: NextSourceResult,
  status: LoopStatus,
  workflow: Pick<Workflow, "inputs" | "inputDefaults"> | undefined,
): NextCommandCheck {
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
  return { kind: "input", inputSet: checked.inputs };
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

function withPause(
  status: LoopStatus,
  action: LoopAction,
  options: NextLoopActionOptions,
): LoopAction {
  return action.kind === "start" ? (pauseAction(status, options) ?? action) : action;
}

function optionsAfterRecordedPause(
  options: NextLoopActionOptions,
  history: readonly LoopEvent[],
): NextLoopActionOptions {
  const lastPauseOrRun = history.findLast(
    (event) => event.type === "loop.paused" || event.type === "loop.run_started",
  );
  return lastPauseOrRun?.type === "loop.paused" ? { ...options, pauseMs: null } : options;
}

function pauseAction(status: LoopStatus, options: NextLoopActionOptions): LoopAction | undefined {
  const pauseMs = options.pauseMs ?? null;
  if (status.runs === 0 || pauseMs === null || pauseMs <= 0 || status.pausedUntil !== null) {
    return undefined;
  }
  const now = options.now ?? new Date();
  return { kind: "pause", until: new Date(now.getTime() + pauseMs).toISOString() };
}
