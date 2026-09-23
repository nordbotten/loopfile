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

export interface LoopTotals {
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly retries: number;
  readonly wallMs: number | null;
  readonly costUsd: number | null;
  readonly runsWithoutCost: number;
  readonly meanMsPerCompleted: number | null;
  readonly meanCostUsdPerCompleted: number | null;
}

export interface LoopStatusView {
  readonly loop: Omit<LoopStatus, "state"> & { readonly state: LoopListState };
  readonly runs: readonly LoopRunStatusView[];
  readonly totals: LoopTotals;
}

export function buildLoopStatusView(
  status: LoopStatus,
  state: LoopListState,
  runs: readonly LoopRunStatusView[],
  now: string,
): LoopStatusView {
  return {
    loop: { ...status, state },
    runs,
    totals: loopTotals(runs, status.startedAt, status.endedAt, now),
  };
}

export function loopTotals(
  runs: readonly LoopRunStatusView[],
  startedAt: string,
  endedAt: string | null,
  now: string,
): LoopTotals {
  const counts = countRuns(runs);
  const costs = costTotals(runs);
  return {
    ...counts,
    wallMs: durationMs(startedAt, endedAt ?? now),
    costUsd: costs.costUsd,
    runsWithoutCost: costs.runsWithoutCost,
    meanMsPerCompleted: meanCompletedElapsed(runs),
    meanCostUsdPerCompleted: costs.meanCostUsdPerCompleted,
  };
}

interface RunCounts {
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly retries: number;
}

function countRuns(runs: readonly LoopRunStatusView[]): RunCounts {
  const counts = { completed: 0, failed: 0, cancelled: 0, retries: 0 };
  for (const run of runs) {
    counts.completed += Number(run.state === "completed");
    counts.failed += Number(run.state === "failed");
    counts.cancelled += Number(run.state === "cancelled");
    counts.retries += Number(run.retryOf !== null);
  }
  return counts;
}

interface CostTotals {
  readonly costUsd: number | null;
  readonly runsWithoutCost: number;
  readonly meanCostUsdPerCompleted: number | null;
}

function costTotals(runs: readonly LoopRunStatusView[]): CostTotals {
  let costUsd: number | null = null;
  let runsWithoutCost = 0;
  let completedWithCost = 0;
  let completedCostTotal = 0;
  for (const run of runs) {
    const cost = run.metrics?.costUsd ?? null;
    runsWithoutCost += Number(cost === null);
    if (cost !== null) {
      costUsd = (costUsd ?? 0) + cost;
      completedWithCost += Number(run.state === "completed");
      if (run.state === "completed") completedCostTotal += cost;
    }
  }
  return {
    costUsd,
    runsWithoutCost,
    meanCostUsdPerCompleted:
      completedWithCost === 0 ? null : completedCostTotal / completedWithCost,
  };
}

function meanCompletedElapsed(runs: readonly LoopRunStatusView[]): number | null {
  let total = 0;
  let completed = 0;
  for (const run of runs) {
    if (run.state !== "completed") continue;
    completed += 1;
    if (run.elapsedMs === null) return null;
    total += run.elapsedMs;
  }
  return completed === 0 ? null : total / completed;
}

function durationMs(startedAt: string, endedAt: string): number | null {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? duration : null;
}

/** Plain text only: one loop fact per line followed by the newest-last run table and totals. */
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
  return `${lines.join("\n")}\n\n${renderRuns(view.runs.slice(-10))}${renderTotals(view.totals)}\n`;
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

function renderTotals(totals: LoopTotals): string {
  const parts = [`${totals.completed} completed`];
  if (totals.failed > 0) parts.push(`${totals.failed} failed`);
  if (totals.cancelled > 0) parts.push(`${totals.cancelled} cancelled`);
  parts.push(`${totals.retries} retries`);
  parts.push(`wall ${formatElapsed(totals.wallMs)}`);
  parts.push(`est. $${money(totals.costUsd)}`);
  if (totals.runsWithoutCost > 0)
    parts[parts.length - 1] += ` (${totals.runsWithoutCost} runs without cost)`;
  if (totals.completed > 0) {
    parts.push(
      `mean ${formatElapsed(totals.meanMsPerCompleted)} / est. $${money(totals.meanCostUsdPerCompleted)} per completed run`,
    );
  }
  return `totals: ${parts.join(", ")}`;
}

function money(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
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
