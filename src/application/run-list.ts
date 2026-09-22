/**
 * `list`: turning one run's status projection (or the lack of one) into a
 * `RunListEntry`, sorting a run's row against the rest, and rendering both
 * the human and `--json` output (#52).
 *
 * Everything here is pure: a status projection, a liveness answer and a clock
 * go in, a row or rendered text comes out. It touches no file and no socket,
 * so the crashed/unknown/unreadable decisions and the rendering can be tested
 * without a run folder. Reading the run folder, pinging `owner.sock` and
 * finding the last `owner.started` host is `src/adapters/run-discovery.ts`.
 */

import type { RunId } from "../domain/model.ts";
import {
  LIST_FORMAT_VERSION,
  type RunList,
  type RunListEntry,
  type RunListState,
} from "../domain/run-list.ts";
import type { RunLifecycle, StatusProjection } from "../domain/status.ts";

/** A run folder name this tool made: a UTC stamp to the second, then a random tail (`run-directory.ts`). */
const RUN_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[a-z2-7]{4}$/;
const LOOP_ID_PATTERN = /^loop-\d{4}\d{2}\d{2}-\d{2}\d{2}\d{2}-[a-z2-7]{4}$/;

/** Whether `name` is a loop ID this tool could have made. */
export function isLoopId(name: string): boolean {
  return LOOP_ID_PATTERN.test(name);
}

/** Whether `name` is a run ID this tool could have made, and so a run folder `list` should show. */
export function isRunId(name: string): boolean {
  return RUN_ID_PATTERN.test(name);
}

/**
 * The start time a run ID itself carries, or `undefined` when `runId` does not
 * match the shape `newRunId` makes.
 *
 * Used only when `status.json` could not be read: the run folder's name is
 * still a fact `list` can show a start time and an elapsed time from, so a
 * broken or missing status file does not blank the whole row.
 */
export function startedAtFromRunId(runId: RunId): string | undefined {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

/** What `deriveRunListEntry` needs beyond the run ID. */
export interface DeriveRunListEntryInput {
  readonly runId: RunId;
  /** `undefined` when `status.json` is missing, unreadable or not a valid v1 projection. */
  readonly status: StatusProjection | undefined;
  /**
   * The host the run's last `owner.started` event named, or `undefined` when
   * it could not be read. Ignored unless `status.state` is `"running"`: an
   * ended run's host never changes what happened.
   */
  readonly ownerHost: string | undefined;
  readonly thisHost: string;
  /**
   * Whether `owner.sock` answered with this run's ID. Ignored unless a
   * liveness check is actually needed (`status.state` is `"running"` and
   * `ownerHost` matches `thisHost`).
   */
  readonly alive: boolean;
  /** The command's own clock, used for `elapsedMs` while a run has not ended. */
  readonly now: string;
}

/**
 * One run's row: `status`'s own state widened with the two a reader derives,
 * and the fields `list` shows (ADR 0007, ADR 0008).
 */
export function deriveRunListEntry(input: DeriveRunListEntryInput): RunListEntry {
  const { runId, status, now } = input;
  if (status === undefined) return unreadableEntry(runId, now);

  return {
    runId,
    loopfileName: status.loopfileName,
    state: derivedState(status.state, input.ownerHost, input.thisHost, input.alive),
    currentStep: currentOrLastStep(status),
    startedAt: status.startedAt,
    elapsedMs: elapsedMs(status.startedAt, endedAtOf(status), now),
  };
}

function unreadableEntry(runId: RunId, now: string): RunListEntry {
  const startedAt = startedAtFromRunId(runId) ?? null;
  return {
    runId,
    loopfileName: null,
    state: "unreadable",
    currentStep: null,
    startedAt,
    elapsedMs: elapsedMs(startedAt, null, now),
  };
}

/**
 * `status.state` as `list` shows it: unchanged once a run has ended, since
 * nothing about a finished run can still be crashed or unknown. A `"running"`
 * run is checked against the host that last claimed it and, only for one on
 * this host, against whether `owner.sock` still answers (ADR 0008).
 */
function derivedState(
  state: RunLifecycle,
  ownerHost: string | undefined,
  thisHost: string,
  alive: boolean,
): RunListState {
  if (state !== "running") return state;
  if (ownerHost !== undefined && ownerHost !== thisHost) return "unknown";
  return alive ? "running" : "crashed";
}

function currentOrLastStep(status: StatusProjection): string | null {
  return status.current?.stepId ?? status.visitedSteps.at(-1)?.stepId ?? null;
}

/** `status.json`'s own `endedAt`, `null` while the file itself says `"running"`. */
function endedAtOf(status: StatusProjection): string | null {
  return status.state === "running" ? null : status.endedAt;
}

/** `endedAt` when the run has one, otherwise `now`: how long a still-open run has run so far. */
function elapsedMs(startedAt: string | null, endedAt: string | null, now: string): number | null {
  if (startedAt === null) return null;
  return Date.parse(endedAt ?? now) - Date.parse(startedAt);
}

/** Every state that means "no end event yet", for sorting and rendering. */
const ACTIVE_STATES: ReadonlySet<RunListState> = new Set<RunListState>([
  "running",
  "crashed",
  "unknown",
]);

function isActive(state: RunListState): boolean {
  return ACTIVE_STATES.has(state);
}

/**
 * `entries` sorted newest-first, active runs (`running`, `crashed`, `unknown`
 * — every state that means "no end event yet") ahead of ended ones so they
 * are easy to find without reading every row (ADR 0007, ADR 0008), and newest
 * first within each group.
 *
 * `startedAt` sorts every real run correctly: it comes straight from
 * `status.json`, or, when that could not be read, from the run ID's own
 * timestamp (`startedAtFromRunId`), which is the same value `status.json`
 * would have held. It is `null` only for a run ID this tool never made, and
 * such a row sorts last within its group rather than crash the comparison.
 */
export function sortRunListEntries(entries: readonly RunListEntry[]): readonly RunListEntry[] {
  return [...entries].sort((a, b) => {
    const group = Number(isActive(b.state)) - Number(isActive(a.state));
    if (group !== 0) return group;
    return startedAtMillis(b.startedAt) - startedAtMillis(a.startedAt);
  });
}

function startedAtMillis(startedAt: string | null): number {
  return startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(startedAt);
}

/** `list --json`'s whole output, `entries` already sorted (`sortRunListEntries`). */
export function buildRunList(entries: readonly RunListEntry[]): RunList {
  return { formatVersion: LIST_FORMAT_VERSION, runs: entries };
}

/** What `list` prints when no run folder exists at all. */
export const NO_RUNS_MESSAGE = "no runs found\n";

/** One column's header and how to read it off a row, for `renderRunList`. */
interface Column {
  readonly header: string;
  cell(entry: RunListEntry): string;
}

const COLUMNS: readonly Column[] = [
  { header: "RUN ID", cell: (entry) => entry.runId },
  { header: "STATE", cell: (entry) => entry.state },
  { header: "STEP", cell: (entry) => entry.currentStep ?? "-" },
  { header: "STARTED", cell: (entry) => entry.startedAt ?? "unknown" },
  { header: "ELAPSED", cell: (entry) => formatElapsed(entry.elapsedMs) },
  { header: "LOOPFILE", cell: (entry) => entry.loopfileName ?? "-" },
];

/** How long a run marked `"running"` shows in bold, so it stands out even once sorted alongside others. */
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * `list`'s human-readable table, `entries` already sorted (`sortRunListEntries`).
 *
 * A `"running"` row is bold when `ansi` is true, and plain otherwise, so a
 * pipe or a redirect (`stdout` not a terminal) never carries an escape code.
 * Sorting already puts every active run first, so this is a mark on top of
 * that grouping, not the only way to find one.
 */
export function renderRunList(entries: readonly RunListEntry[], ansi: boolean): string {
  const widths = COLUMNS.map((column) =>
    Math.max(column.header.length, ...entries.map((entry) => column.cell(entry).length)),
  );
  const lines = [
    renderRow(
      COLUMNS.map((c) => c.header),
      widths,
    ),
  ];
  for (const entry of entries) {
    const row = renderRow(
      COLUMNS.map((column) => column.cell(entry)),
      widths,
    );
    lines.push(entry.state === "running" && ansi ? `${BOLD}${row}${RESET}` : row);
  }
  return `${lines.join("\n")}\n`;
}

function renderRow(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
    .join("  ")
    .trimEnd();
}

export function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return "unknown";
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":");
}
