/** The human and JSON views of one loop and its child runs (#71). */

import type { InputSet } from "../domain/events.ts";
import type { RunId } from "../domain/model.ts";
import type { LoopListState, RunListState } from "../domain/run-list.ts";
import type { LoopStatus, StatusMetrics } from "../domain/status.ts";
import { formatElapsed } from "./run-list.ts";

export interface LoopRunStatusView {
  readonly index: number;
  readonly runId: RunId;
  readonly inputSet: InputSet;
  readonly retryOf: RunId | null;
  readonly state: RunListState;
  readonly elapsedMs: number | null;
  readonly metrics: StatusMetrics | null;
}

export interface LoopStatusView {
  readonly loop: Omit<LoopStatus, "state"> & { readonly state: LoopListState };
  readonly runs: readonly LoopRunStatusView[];
}

export function buildLoopStatusView(
  status: LoopStatus,
  state: LoopListState,
  runs: readonly LoopRunStatusView[],
): LoopStatusView {
  return { loop: { ...status, state }, runs };
}

/** Plain text only: one loop fact per line followed by the newest-last run table. */
export function renderLoopStatusView(view: LoopStatusView, currentStep: string | null): string {
  const loop = view.loop;
  const lines = [
    `loop: ${loop.loopId}`,
    `state: ${loop.state}`,
    `loopfile: ${loop.loopfileName}`,
    `source: ${sourceText(loop.source)}`,
  ];
  if (loop.place !== null && loop.source.kind !== "next") {
    lines.push(`place: ${loop.place} of ${loop.source.count}`);
  }
  lines.push(`runs: ${loop.runs} (${loop.retries} retries)`);
  if (loop.currentRunId !== null && currentStep !== null) {
    lines.push(`current: ${loop.currentRunId} at step ${currentStep}`);
  }
  if (loop.pausedUntil !== null) lines.push(`next run: ${loop.pausedUntil}`);
  if (loop.endedAt !== null) lines.push(`ended: ${endText(loop)}`);
  return `${lines.join("\n")}\n\n${renderRuns(view.runs.slice(-10))}`;
}

function sourceText(source: LoopStatus["source"]): string {
  return source.kind === "next" ? `next ${source.command}` : `${source.kind} ${source.count}`;
}

function endText(loop: LoopStatusView["loop"]): string {
  let text = loop.endReason ?? "unknown";
  if (text === "cancelled" && loop.cancelMode !== null) text += ` (${loop.cancelMode})`;
  if (loop.detail !== null && loop.detail !== "") text += ` - ${loop.detail}`;
  return text;
}

const COLUMNS = [
  { header: "#", cell: (run: LoopRunStatusView) => String(run.index) },
  { header: "RUN ID", cell: (run: LoopRunStatusView) => run.runId },
  { header: "INPUT SET", cell: (run: LoopRunStatusView) => inputSetText(run.inputSet) },
  { header: "STATE", cell: (run: LoopRunStatusView) => run.state },
  { header: "TIME", cell: (run: LoopRunStatusView) => formatElapsed(run.elapsedMs) },
  { header: "COST", cell: (run: LoopRunStatusView) => costText(run.metrics) },
] as const;

function renderRuns(runs: readonly LoopRunStatusView[]): string {
  const widths = COLUMNS.map((column) =>
    Math.max(column.header.length, ...runs.map((run) => column.cell(run).length)),
  );
  const rows = [
    renderRow(
      COLUMNS.map((column) => column.header),
      widths,
    ),
  ];
  for (const run of runs)
    rows.push(
      renderRow(
        COLUMNS.map((column) => column.cell(run)),
        widths,
      ),
    );
  return `${rows.join("\n")}\n`;
}

function renderRow(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
    .join("  ")
    .trimEnd();
}

function inputSetText(inputSet: InputSet): string {
  const values = Object.entries(inputSet).map(([name, value]) => `${name}=${value.slice(0, 20)}`);
  return values.join(" ");
}

function costText(metrics: StatusMetrics | null): string {
  return metrics === null || metrics.costUsd === null ? "-" : `est. $${metrics.costUsd.toFixed(2)}`;
}
