/**
 * The v1 `list --json` shape (#52, ADR 0006, ADR 0007).
 *
 * `loopfile list` scans every loop and run folder and shows one row per
 * object. Each row is a small, derived summary, not a copy of `status.json`.
 * The discovery adapters are the one place that read state folders to build
 * these; `status` (#36) reuses run discovery for its own bare, interactive
 * listing rather than scanning the folder a second way.
 *
 * `RunListState` widens `RunLifecycle` (`src/domain/status.ts`) with the two
 * states a reader derives and `status.json` never holds (`crashed`, `unknown`,
 * ADR 0007, ADR 0008) plus one more a reader needs of its own: `unreadable`,
 * for a run folder whose `status.json` could not be read at all. A `list` row
 * still needs a state to show even then, and "the file did not parse" is not
 * the same fact as "the run crashed".
 */

import type { Timestamp } from "./events.ts";
import type { LoopId, RunId } from "./model.ts";
import type { LoopLifecycle, LoopStatusSource, RunLifecycle } from "./status.ts";

/** The `list --json` format version this tool writes (ADR 0006). */
export const LIST_FORMAT_VERSION = 1;

/** Every state a `list` row may show, `RunLifecycle` plus what a reader derives. */
export type RunListState = RunLifecycle | "crashed" | "unknown" | "unreadable";

/**
 * One run's row.
 *
 * `loopfileName` and `currentStep` are `null` when `status.json` could not be
 * read (`state` is `unreadable`) or, for `currentStep`, when the run has not
 * started a step yet. `startedAt` is `null` only when the run ID itself does
 * not carry a start time (`src/application/run-list.ts`), which never happens
 * for a run this tool created. `elapsedMs` is `null` exactly when `startedAt`
 * is, so a consumer needs one check for both.
 */
export interface RunListEntry {
  readonly runId: RunId;
  readonly loopId: LoopId | null;
  readonly loopfileName: string | null;
  readonly state: RunListState;
  readonly currentStep: string | null;
  readonly startedAt: Timestamp | null;
  readonly elapsedMs: number | null;
}

/** Every state a `list` loop row may show. */
export type LoopListState = LoopLifecycle | "crashed";

/** One loop's derived summary in `list --json`. */
export interface LoopListEntry {
  readonly loopId: LoopId;
  readonly loopfileName: string;
  readonly state: LoopListState;
  readonly source: LoopStatusSource;
  readonly runs: number;
  readonly startedAt: Timestamp;
  readonly elapsedMs: number;
}

/** `list --json`'s whole output. */
export interface RunList {
  readonly formatVersion: typeof LIST_FORMAT_VERSION;
  readonly loops: readonly LoopListEntry[];
  readonly runs: readonly RunListEntry[];
}
