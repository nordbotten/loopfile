/** The operator's read-only result view over a run event log (#226). */

import type { RunEvent } from "../domain/events.ts";
import type { WorkspaceMode } from "../domain/model.ts";
import type { RunLifecycle, StatusEndReason, StatusMetrics } from "../domain/status.ts";
import { replay } from "./replay.ts";
import { runLocation } from "./run-location.ts";
import { lifecycleOf, UNKNOWN_METRICS } from "./status-projection.ts";

export const RESULT_FORMAT_VERSION = 1;

export interface ResultArgs {
  readonly ok: true;
  readonly runId: string;
  readonly json: boolean;
}

export interface ResultArgsFailure {
  readonly ok: false;
  readonly message: string;
}

const USAGE = "Usage: loopfile result <runid|loopid> [--json]";

/** Parses the operator form; the step form has its own grammar in result.ts. */
export function parseResultCommandArgs(argv: readonly string[]): ResultArgs | ResultArgsFailure {
  const json = argv.includes("--json");
  const rest = argv.slice(1).filter((token) => token !== "--json");
  const runId = rest[0];
  if (runId === undefined || runId.startsWith("--")) {
    return { ok: false, message: `\`result\` needs a run ID.\n${USAGE}` };
  }
  if (rest.length > 1) return { ok: false, message: `unknown argument: ${rest[1]}\n${USAGE}` };
  return { ok: true, runId, json };
}

export interface LastOutcome {
  readonly stepId: string;
  readonly attemptId: string;
  readonly outcome: string;
  readonly message: string | null;
}

export interface ResultValue {
  readonly value: string | null;
  readonly size: number;
  readonly truncated: boolean;
  readonly path: string | null;
}

export interface ResultValues {
  readonly inputs: Readonly<Record<string, ResultValue>>;
  readonly outputs: Readonly<Record<string, ResultValue>>;
}

export interface ResultView {
  readonly formatVersion: typeof RESULT_FORMAT_VERSION;
  readonly runId: string;
  readonly loopfileName: string;
  readonly loopId: string | null;
  readonly loopIndex: number | null;
  readonly state: RunLifecycle;
  readonly endReason: StatusEndReason | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly targetFolder: string;
  readonly workspace: string;
  readonly workspaceMode: WorkspaceMode | "";
  readonly branch: string;
  readonly baseCommit: string;
  readonly metrics: StatusMetrics;
  readonly lastOutcome: LastOutcome | null;
  readonly inputs: Readonly<Record<string, ResultValue>>;
  readonly outputs: Readonly<Record<string, ResultValue>>;
}

const EMPTY_VALUES: ResultValues = { inputs: {}, outputs: {} };

/** Builds the versioned operator result without reading files or contacting a run owner. */
export function buildResultView(
  events: readonly RunEvent[],
  loopfileName: string,
  values: ResultValues = EMPTY_VALUES,
  metrics?: StatusMetrics,
): ResultView {
  const created = events[0];
  if (created?.type !== "run.created")
    throw new Error("events.jsonl does not start with run.created");

  const state = replay(events);
  const lifecycle = lifecycleOf(state.result);
  const ended = events.findLast(isTerminal);
  const outcome = events.findLast((event) => event.type === "outcome.reported");

  return {
    formatVersion: RESULT_FORMAT_VERSION,
    runId: created.runId,
    loopfileName,
    loopId: created.loopId ?? null,
    loopIndex: created.loopIndex ?? null,
    state: lifecycle.state,
    endReason: lifecycle.endReason,
    startedAt: created.at,
    endedAt: ended?.at ?? null,
    ...runLocation(created),
    metrics: resultMetrics(events, metrics),
    lastOutcome: outcome === undefined ? null : lastOutcome(events, outcome),
    inputs: values.inputs,
    outputs: values.outputs,
  };
}

const LABEL_WIDTH = 13;

function resultLine(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}`.trimEnd();
}

/** Renders the compact human form; every result value occupies one line. */
export function renderResultView(view: ResultView): string {
  const lines = [resultLine("run", `${view.runId} · ${view.loopfileName}`)];
  if (view.loopId !== null && view.loopIndex !== null) {
    lines.push(`loop: ${view.loopId} (run ${view.loopIndex})`);
  }
  lines.push(
    resultLine("state", view.state),
    resultLine("started", view.startedAt),
    resultLine(
      "ended",
      view.endedAt === null ? "not yet" : `${view.endReason ?? "unknown"} at ${view.endedAt}`,
    ),
    resultLine("target", view.targetFolder),
    resultLine(
      "workspace",
      view.workspaceMode === "" ? view.workspace : `${view.workspaceMode} · ${view.workspace}`,
    ),
  );
  if (view.branch !== "") lines.push(resultLine("branch", view.branch));
  if (view.baseCommit !== "") lines.push(resultLine("base commit", view.baseCommit));
  lines.push(
    resultLine("last outcome", outcomeText(view.lastOutcome)),
    ...valueLines("input", view.inputs),
    ...valueLines("output", view.outputs),
  );
  return `${lines.join("\n")}\n`;
}

function outcomeText(outcome: LastOutcome | null): string {
  if (outcome === null) return "none";
  const message = outcome.message === null ? "" : `: ${oneLine(outcome.message)}`;
  return `${outcome.stepId} (${outcome.attemptId}) · ${outcome.outcome}${message}`;
}

function valueLines(
  label: "input" | "output",
  values: Readonly<Record<string, ResultValue>>,
): readonly string[] {
  const entries = Object.entries(values);
  return entries.length === 0
    ? [resultLine(`${label}s`, "none")]
    : entries.map(([name, value]) => resultLine(label, `${name}: ${valueText(value)}`));
}

function valueText(value: ResultValue): string {
  if (value.value === null) return "null";
  if (value.truncated) return `[truncated; see ${value.path ?? "file"}]`;
  return oneLine(value.value);
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}

function isTerminal(
  event: RunEvent,
): event is Extract<RunEvent, { type: "run.ended" | "run.cancelled" }> {
  return event.type === "run.ended" || event.type === "run.cancelled";
}

function resultMetrics(
  events: readonly RunEvent[],
  metrics: StatusMetrics | undefined,
): StatusMetrics {
  return events.findLast(isTerminal)?.metrics ?? metrics ?? UNKNOWN_METRICS;
}

function lastOutcome(
  events: readonly RunEvent[],
  outcome: Extract<RunEvent, { type: "outcome.reported" }>,
): LastOutcome {
  const attempt = events.findLast(
    (event) => event.type === "attempt.started" && event.attemptId === outcome.attemptId,
  );
  return {
    stepId: attempt?.type === "attempt.started" ? attempt.stepId : "",
    attemptId: outcome.attemptId,
    outcome: outcome.outcome,
    message: outcome.message ?? null,
  };
}
