/**
 * The live monitor's view (#49): one run's `status.json` drawn as plain
 * text lines.
 *
 * Pure. A view and a clock go in, whole lines come out. Reading the file,
 * pinging the run owner and reading keys is `src/adapters/monitor.ts`. Only
 * the state word is bold, through `util.styleText`; there is no Ink or React
 * (ADR 0001).
 */

import { styleText } from "node:util";
import type { RunId } from "../domain/model.ts";
import type { StatusProjection } from "../domain/status.ts";
import { formatElapsed } from "./run-list.ts";
import { ownerGoneMessage } from "./tail.ts";

/**
 * What the monitor draws. `unknown` is a run whose owner lives on another
 * host: a ping cannot tell if it is alive, so the monitor does not claim it
 * is running or crashed (ADR 0008).
 */
export type MonitorView =
  | { readonly kind: "waiting"; readonly runId: RunId }
  | { readonly kind: "live"; readonly status: StatusProjection }
  | { readonly kind: "unknown"; readonly status: StatusProjection }
  | { readonly kind: "ended"; readonly status: StatusProjection }
  | {
      readonly kind: "crashed";
      readonly runId: RunId;
      readonly status: StatusProjection | undefined;
    };

export const DETACH_HINT = "d detach · run continues";

const LABEL_WIDTH = 10;

/** Pure. `now` is an ISO time. Returns whole lines, each ending in "\n". */
export function renderMonitor(view: MonitorView, now: string): string {
  if (view.kind === "waiting") {
    return `waiting for run ${view.runId} to write status.json\n${DETACH_HINT}\n`;
  }
  const status = view.status;
  if (status === undefined) {
    // Only `crashed` can lack a status; TypeScript cannot narrow `view` through it.
    return toText([line("state", crashedText((view as { runId: RunId }).runId))]);
  }
  const lines: string[] = [];
  lines.push(line("run", `${status.runId} · ${status.loopfileName}`));
  lines.push(line("state", stateText(view, status, now)));
  if (view.kind !== "ended") lines.push(line("step", stepText(status)));
  lines.push(line("activity", activityText(status, now)));
  lines.push(line("metrics", metricsText(status)));
  lines.push(line("route", routeText(status)));
  lines.push(line("visited", visitedText(status)));
  if (view.kind === "live" || view.kind === "unknown") lines.push(DETACH_HINT);
  return toText(lines);
}

/** What `attachMonitor` says when stdin or stdout is not a terminal. */
export function notTerminalMessage(runId: RunId): string {
  return `the monitor needs a terminal. Use \`loopfile status ${runId}\` or \`loopfile tail ${runId}\` instead`;
}

function toText(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function line(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}`.trimEnd();
}

function bold(text: string): string {
  return styleText("bold", text);
}

function elapsedBetween(from: string, to: string): string {
  return formatElapsed(Date.parse(to) - Date.parse(from));
}

function stateText(view: MonitorView, status: StatusProjection, now: string): string {
  const elapsed = elapsedBetween(status.startedAt, status.endedAt ?? now);
  if (view.kind === "ended") {
    return `${bold(status.state)} (${status.endReason ?? "unknown"})`;
  }
  if (view.kind === "crashed") {
    return crashedText(status.runId);
  }
  return `${bold(view.kind === "unknown" ? "unknown" : status.state)} · ${elapsed}`;
}

function crashedText(runId: RunId): string {
  return `${bold("crashed")} · ${ownerGoneMessage(runId)}`;
}

function stepText(status: StatusProjection): string {
  const current = status.current;
  if (current === null) return "- (between steps)";
  const kind =
    current.harness === null ? current.stepKind : `${current.stepKind}, ${current.harness}`;
  const iteration =
    current.iteration === null
      ? ""
      : ` · iteration ${current.iteration}/${current.maxIterations ?? "unknown"}`;
  return `${current.stepId} (${kind}) · attempt ${current.attempt}/${current.maxAttempts}${iteration}`;
}

function activityText(status: StatusProjection, now: string): string {
  const age = elapsedBetween(status.lastActivityAt, now);
  return `${age} ago · ${status.lastProgress ?? "no progress yet"}`;
}

function metric(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function metricsText(status: StatusProjection): string {
  const m = status.metrics;
  const cost = m.costUsd === null ? "unknown" : `$${m.costUsd.toFixed(2)}`;
  return (
    `tokens ${metric(m.totalTokens)} (in ${metric(m.inputTokens)} / out ${metric(m.outputTokens)})` +
    ` · cost ${cost} · tool calls ${metric(m.toolCalls)}` +
    ` · permission denials ${metric(m.permissionDenials)}`
  );
}

function routeText(status: StatusProjection): string {
  const t = status.lastTransition;
  if (t === null) return "-";
  const why = t.outcome ?? t.cause;
  const limit = status.maxTransitions ?? "no limit";
  return `${t.from} → ${t.to} (${why}) · transitions ${status.transitions}/${limit}`;
}

function visitedText(status: StatusProjection): string {
  return status.visitedSteps.map((v) => `${v.stepId} ×${v.attempts}`).join(", ");
}
