/**
 * Writing a run's `status.json` (#48, ADR 0007).
 *
 * The run owner is the one writer. Every write goes to a temp file next to
 * `status.json`, then a rename over it, so a reader never sees a half-written
 * file — a plain `readFile` either gets the old content or the new one, never
 * a mix, because `rename` on the same filesystem is atomic.
 *
 * Two kinds of update reach this writer:
 *
 * - An **event update**, for an event that changes the view (run and attempt
 *   start and end, a transition, an outcome, a data put). Never delayed.
 * - A **live update**, harness data such as progress text and metrics, which
 *   `openStatusWriter`'s caller (#25a) may call many times a second. These are
 *   rate-limited to about one write per second per run; the latest call before
 *   each write is the one that lands, and none is silently dropped for good —
 *   a call that arrives too soon schedules the next write instead of being
 *   skipped.
 *
 * `projectStatus` (`application/status-projection.ts`) decides what the file
 * should say; this module only ever gets it onto disk.
 */

import { rename, writeFile } from "node:fs/promises";
import {
  type HarnessData,
  NO_HARNESS_DATA,
  type ProjectStatusContext,
  projectStatus,
} from "../application/status-projection.ts";
import type { RunEvent } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";

/** About how often a live update may reach disk (ADR 0007: "about one write per second"). */
export const LIVE_UPDATE_INTERVAL_MS = 1_000;

/** A run's status writer, open for the run's lifetime. */
export interface StatusWriter {
  /**
   * Writes `status.json` now, from `events`: for an event that changes the
   * view. Keeps whatever harness data the last live update reported.
   */
  onEvent(events: readonly RunEvent[]): Promise<void>;
  /**
   * Reports live harness data. Writes at once unless a write already landed
   * within the last `minIntervalMs`, in which case it schedules one for when
   * that window ends. A second call before that write fires replaces the data
   * it will write, so only the latest is ever stale.
   */
  onHarnessUpdate(events: readonly RunEvent[], harnessData: HarnessData): void;
  /** Resolves once every write this writer owes — including a scheduled one — is on disk. */
  flush(): Promise<void>;
}

/** What a status writer needs to open. */
export interface OpenStatusWriterOptions {
  /** `RunPaths.status`, usually. */
  readonly path: string;
  readonly workflow: Workflow;
  readonly loopfileName: string;
  /** The run's events so far, from `events.jsonl`: the whole log on start or resume. */
  readonly events: readonly RunEvent[];
  /** Overridable for tests only. */
  readonly minIntervalMs?: number;
  /** Overridable for tests only. Milliseconds, monotonic direction assumed. */
  readonly now?: () => number;
}

/**
 * Opens a run's status writer and writes the first `status.json` at once,
 * fresh from `options.events` with no live harness data. Ended-attempt metrics
 * still come from the event log; current-attempt metrics are unknown until the
 * harness reports them again (ADR 0007).
 */
export async function openStatusWriter(options: OpenStatusWriterOptions): Promise<StatusWriter> {
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? LIVE_UPDATE_INTERVAL_MS;

  // The events and harness data a write should use are always these two
  // variables, current at write time — never the arguments a caller happened
  // to pass when a write was scheduled. A pending live update's write is a
  // `setTimeout` fired later, by which time an event update may have moved
  // the run on (to `run.ended`, or just to a later `seq`); reading these
  // instead of a captured snapshot is what keeps that write from landing
  // stale (#48 review: a scheduled write must never show older events than
  // the newest ones already written).
  let latestEvents = options.events;
  let harnessData = NO_HARNESS_DATA;
  let queue: Promise<void> = Promise.resolve();
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pending: NodeJS.Timeout | undefined;

  const context = (): ProjectStatusContext => ({
    workflow: options.workflow,
    loopfileName: options.loopfileName,
    updatedAt: new Date(now()).toISOString(),
  });

  function write(): Promise<void> {
    lastWriteAt = now();
    const projection = projectStatus(latestEvents, context(), harnessData);
    queue = queue.then(
      () => atomicWrite(options.path, projection),
      () => atomicWrite(options.path, projection),
    );
    return queue;
  }

  await write();

  return {
    onEvent(events) {
      latestEvents = events;
      return write();
    },
    onHarnessUpdate(events, data) {
      latestEvents = events;
      harnessData = data;
      // A write is already scheduled: it will read `latestEvents` and
      // `harnessData` when it fires, so this call needs no timer of its own.
      if (pending !== undefined) return;
      const elapsed = now() - lastWriteAt;
      if (elapsed >= minIntervalMs) {
        void write();
        return;
      }
      pending = setTimeout(() => {
        pending = undefined;
        void write();
      }, minIntervalMs - elapsed);
      pending.unref?.();
    },
    async flush(): Promise<void> {
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
        await write();
      }
      await queue;
    },
  };
}

/**
 * Writes `projection` to `path` by writing a temp file in the same folder and
 * renaming it over `path`, so a reader's `readFile` never lands mid-write.
 */
async function atomicWrite(path: string, projection: unknown): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(projection)}\n`);
  await rename(tmpPath, path);
}
