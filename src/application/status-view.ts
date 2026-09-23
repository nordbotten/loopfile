/**
 * `status`: the pure parts (#36). Arguments, the derived view, the human
 * text and the run picker text. Reading the run folder, pinging the socket
 * and the terminal are `src/adapters/status-command.ts`.
 */

import type { RunEvent } from "../domain/events.ts";
import type { LoopListEntry, RunListEntry, RunListState } from "../domain/run-list.ts";
import type { StatusMetrics, StatusProjection } from "../domain/status.ts";
import type { RecentTransition, RunStatusView } from "../domain/status-view.ts";
import { formatElapsed, renderLoopList, renderRunList } from "./run-list.ts";

/** How many transitions `status` shows. */
export const RECENT_TRANSITION_COUNT = 5;

const USAGE = "Usage: loopfile status [<runid>|<loopid>] [--monitor | --json]";

export type StatusArgs =
  | {
      readonly ok: true;
      readonly runId: string | undefined;
      readonly json: boolean;
      readonly monitor: boolean;
    }
  | { readonly ok: false; readonly message: string };

export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  let runId: string | undefined;
  let json = false;
  let monitor = false;
  for (const token of argv.slice(1)) {
    if (token === "--json") json = true;
    else if (token === "--monitor") monitor = true;
    else if (token.startsWith("--") || runId !== undefined) {
      return { ok: false, message: `unknown argument: ${token}\n${USAGE}` };
    } else runId = token;
  }
  const conflict = jsonConflict(json, runId, monitor);
  if (conflict !== undefined) return { ok: false, message: `${conflict}\n${USAGE}` };
  return { ok: true, runId, json, monitor };
}

/** Why `--json` cannot be used with these arguments, or `undefined`. */
function jsonConflict(
  json: boolean,
  runId: string | undefined,
  monitor: boolean,
): string | undefined {
  if (!json) return undefined;
  if (runId === undefined) return "`status --json` needs a run ID.";
  return monitor ? "`status` takes --monitor or --json, not both." : undefined;
}

export function notTerminalStatusMessage(): string {
  return "`loopfile status` with no run ID needs a terminal. Use `loopfile list` to find a run, then `loopfile status <runid>`";
}

export function unreadableStatusMessage(runId: string): string {
  return `run ${runId} has no readable status.json`;
}

/** The last `count` transition events, oldest first. */
export function recentTransitions(
  events: readonly RunEvent[],
  count: number = RECENT_TRANSITION_COUNT,
): readonly RecentTransition[] {
  return events
    .flatMap((event) =>
      event.type === "transition"
        ? [
            {
              at: event.at,
              from: event.from,
              to: event.to,
              cause: event.cause,
              outcome: event.outcome ?? null,
            },
          ]
        : [],
    )
    .slice(-count);
}

export function buildStatusView(
  status: StatusProjection,
  state: RunListState,
  transitions: readonly RecentTransition[],
): RunStatusView {
  return { ...status, state, recentTransitions: transitions };
}

const LABEL_WIDTH = 12;

function line(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}`.trimEnd();
}

function orUnknown(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function metricsText(metrics: StatusMetrics): string {
  const cost = metrics.costUsd === null ? "unknown" : `$${metrics.costUsd}`;
  return [
    `input tokens ${orUnknown(metrics.inputTokens)}`,
    `output tokens ${orUnknown(metrics.outputTokens)}`,
    `total tokens ${orUnknown(metrics.totalTokens)}`,
    `cost ${cost}`,
    `tool calls ${orUnknown(metrics.toolCalls)}`,
    `permission denials ${orUnknown(metrics.permissionDenials)}`,
  ].join(" · ");
}

function currentText(current: NonNullable<StatusProjection["current"]>): string {
  const parts = [
    `${current.stepId} (${current.stepKind})`,
    `attempt ${current.attempt}/${current.maxAttempts}`,
  ];
  if (current.iteration !== null) {
    parts.push(`iteration ${current.iteration}/${orUnknown(current.maxIterations)}`);
  }
  if (current.harness !== null) parts.push(current.harness);
  return parts.join(" · ");
}

function transitionText(transition: RecentTransition): string {
  const outcome = transition.outcome === null ? "" : `, outcome ${transition.outcome}`;
  return `${transition.at}  ${transition.from} -> ${transition.to} (${transition.cause}${outcome})`;
}

/** The human view of one run. Plain text: no ANSI, so a pipe stays clean. */
export function renderStatusView(view: RunStatusView): string {
  const ended = view.endedAt !== null;
  const lines = [line("run", `${view.runId} · ${view.loopfileName}`)];
  if (view.loopId !== null && view.loopIndex !== null) {
    lines.push(`loop: ${view.loopId} (run ${view.loopIndex})`);
  }
  lines.push(line("state", view.state), line("started", view.startedAt));
  if (view.current !== null) lines.push(line("step", currentText(view.current)));
  if (ended) {
    lines.push(line("outcome", `${view.endReason ?? "unknown"} at ${view.endedAt}`));
    lines.push(
      line("elapsed", formatElapsed(Date.parse(view.endedAt) - Date.parse(view.startedAt))),
    );
  }
  lines.push(
    line(
      "visited",
      view.visitedSteps.map((step) => `${step.stepId} ×${step.attempts}`).join(", ") || "none",
    ),
    line("transitions", String(view.transitions)),
  );
  const recent = view.recentTransitions.map(transitionText);
  lines.push(line("recent", recent[0] ?? "none"));
  for (const text of recent.slice(1)) lines.push(line("", text));
  lines.push(line("metrics", metricsText(view.metrics)));
  return `${lines.join("\n")}\n`;
}

/** Numbered `list` tables for the picker. Loops come before runs. */
export function renderPicker(
  entries: readonly RunListEntry[],
  ansi: boolean,
  loops: readonly LoopListEntry[] = [],
): string {
  let number = 1;
  const tables = [
    ...(loops.length === 0 ? [] : [renderLoopList(loops, ansi)]),
    ...(entries.length === 0 ? [] : [renderRunList(entries, ansi)]),
  ];
  return tables
    .flatMap((table) =>
      table.split("\n").map((row, index) => {
        if (row === "") return row;
        return index === 0 ? `    ${row}` : `${`${number++})`.padEnd(4)}${row}`;
      }),
    )
    .join("\n");
}

/** The item index a picker answer names, `"quit"`, or `undefined` for anything else. */
export function parsePick(answer: string, count: number): number | "quit" | undefined {
  const text = answer.trim().toLowerCase();
  if (text === "q") return "quit";
  if (!/^\d+$/.test(text)) return undefined;
  const number = Number(text);
  return number >= 1 && number <= count ? number - 1 : undefined;
}
