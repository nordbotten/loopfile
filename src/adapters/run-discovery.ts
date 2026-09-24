/**
 * `discoverRuns`: the one place that scans `$LOOPFILE_HOME/runs/` and turns
 * what it finds into `RunListEntry` rows (#52).
 *
 * `loopfile list` (`list-command.ts`) is its first caller; bare `loopfile
 * status` (#36) reuses it rather than scan the folder its own way, so the two
 * commands can never disagree about what a crashed or unknown run is.
 *
 * Read-only, like `logs` and `tail`: a run folder is opened to read
 * `status.json` and, when its last transition does not identify its most
 * recent attempt, `events.jsonl`. A run that still says `"running"` also needs
 * the last `owner.started` host and a ping of `owner.sock` (ADR 0008).
 */

import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { OperatorErrorCode, OperatorFailure } from "../application/operator-error.ts";
import { CorruptEventLogError, parseEventLog } from "../application/replay.ts";
import { deriveRunListEntry, isRunId, sortRunListEntries } from "../application/run-list.ts";
import { parseStatusProjection } from "../application/status.ts";
import type { EventRecord, OwnerStarted } from "../domain/events.ts";
import { isEndState } from "../domain/model.ts";
import type { RunListEntry } from "../domain/run-list.ts";
import type { StatusProjection } from "../domain/status.ts";
import { loopfileHome, type RunPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

/** Overridable for tests only. */
export interface DiscoverRunsOptions {
  readonly now?: () => Date;
  readonly pingTimeoutMs?: number;
}

/** A run's event log could not be read as an operator description. */
export class EventLogReadError extends Error {
  readonly code: OperatorErrorCode;
  readonly runId: string;

  constructor(code: OperatorErrorCode, runId: string, message: string) {
    super(message);
    this.code = code;
    this.runId = runId;
  }
}

/** Reads and validates a run's event log, preserving the operator failure kind. */
export function eventLogFailure(error: unknown, runId?: string): OperatorFailure {
  if (error instanceof EventLogReadError) {
    return {
      summary: error.message,
      code: error.code,
      help:
        error.code === "log_corrupt"
          ? "Inspect events.jsonl before retrying the read."
          : "Check that events.jsonl exists and is readable.",
    };
  }
  const runs = runId === undefined;
  const target = runs ? "runs" : `events.jsonl for run ${runId}`;
  return {
    summary: `could not read ${target}${
      error instanceof Error && error.message ? `: ${error.message}` : ""
    }`,
    code: "log_unreadable",
    help: runs
      ? "Check that the runs folder and its contents are readable."
      : "Check that events.jsonl exists and is readable.",
  };
}

export async function readEventLog(path: string, runId: string) {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new EventLogReadError(
      "log_unreadable",
      runId,
      `events.jsonl for run ${runId} could not be opened`,
    );
  }
  try {
    return parseEventLog(text);
  } catch (error) {
    if (error instanceof CorruptEventLogError) {
      throw new EventLogReadError("log_corrupt", runId, error.message);
    }
    throw error;
  }
}

/**
 * Every run under `LOOPFILE_HOME`'s `runs/` folder, newest and most active
 * first (`sortRunListEntries`). An empty or missing `runs/` folder gives an
 * empty list, never an error: a fresh `LOOPFILE_HOME` has run nothing yet.
 */
export async function discoverRuns(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscoverRunsOptions = {},
): Promise<readonly RunListEntry[]> {
  const home = loopfileHome(env);
  const runIds = await listRunIds(join(home, "runs"));
  const thisHost = hostname();
  const now = (options.now?.() ?? new Date()).toISOString();

  const entries = await Promise.all(
    runIds.map(async (runId) => {
      const found = await discoverOneRun(
        runId,
        runPaths(home, runId),
        thisHost,
        now,
        options.pingTimeoutMs,
        true,
      );
      return found.entry;
    }),
  );
  return sortRunListEntries(entries);
}

/** One run's row and the `status.json` it came from (`undefined` when unusable). */
export interface DiscoveredRun {
  readonly entry: RunListEntry;
  readonly status: StatusProjection | undefined;
}

/** The same derivation `discoverRuns` does, for one run ID (`status <runid>`, #36). */
export async function discoverRun(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DiscoverRunsOptions = {},
): Promise<DiscoveredRun> {
  const now = (options.now?.() ?? new Date()).toISOString();
  return await discoverOneRun(
    runId,
    runPaths(loopfileHome(env), runId),
    hostname(),
    now,
    options.pingTimeoutMs,
    false,
  );
}

/**
 * One run's row. `status.json` is always read; `events.jsonl` supplies the
 * latest attempt unless a final transition already names it. A `"running"`
 * run also needs its last owner host and, when that host is this one, a ping
 * of `owner.sock` (ADR 0008).
 */
async function discoverOneRun(
  runId: string,
  paths: RunPaths,
  thisHost: string,
  now: string,
  pingTimeoutMs: number | undefined,
  validateEventLog: boolean,
): Promise<DiscoveredRun> {
  const status = await readStatus(paths.status);
  const derive = (
    ownerHost: string | undefined,
    alive: boolean,
    lastAttemptStepId?: string | null,
  ): DiscoveredRun => ({
    status,
    entry: deriveRunListEntry({
      runId,
      status,
      ownerHost,
      ...(lastAttemptStepId === undefined ? {} : { lastAttemptStepId }),
      thisHost,
      alive,
      now,
    }),
  });
  if (status === undefined) return derive(undefined, false);
  if (status.state !== "running") {
    const lastTransition = status.lastTransition;
    const lastAttemptStepId =
      lastTransition !== null && isEndState(lastTransition.to)
        ? undefined
        : await lastAttemptStepFromLog(paths.events, runId);
    return derive(undefined, false, lastAttemptStepId);
  }

  const lastAttemptStepId = validateEventLog
    ? lastAttemptStep(await readEventLog(paths.events, runId))
    : undefined;
  const ownerHost = await lastOwnerStartedHost(paths.events);
  if (ownerHost !== undefined && ownerHost !== thisHost) {
    return derive(ownerHost, false, lastAttemptStepId);
  }

  const answer = await pingOwner(paths.socket, pingTimeoutMs);
  return derive(ownerHost, answer === runId, lastAttemptStepId);
}

/** `status.json`, parsed and validated, or `undefined` for any reason it could not be used as-is. */
async function readStatus(path: string): Promise<StatusProjection | undefined> {
  return await readFile(path, "utf8")
    .then((text) => parseStatusProjection(JSON.parse(text)))
    .catch(() => undefined);
}

/**
 * The host named by the run's last `owner.started` event, or `undefined` when
 * `events.jsonl` could not be read, could not be parsed, or has no such event.
 * `parseEventLog` reads whatever whole lines it can (only a corrupt line other
 * than the last one throws), so a log with no `owner.started` yet — the moment
 * right after `run.created` — is a normal, unreadable-as-in-"unknown" result
 * here, not a failure.
 */
export async function lastOwnerStartedHost(path: string): Promise<string | undefined> {
  return await readFile(path, "utf8")
    .then((text) => parseEventLog(text))
    .then(
      (events) =>
        events.findLast((event): event is OwnerStarted => event.type === "owner.started")?.host,
    )
    .catch(() => undefined);
}

async function lastAttemptStepFromLog(
  path: string,
  runId: string,
): Promise<string | null | undefined> {
  try {
    return lastAttemptStep(await readEventLog(path, runId));
  } catch {
    return undefined;
  }
}

function lastAttemptStep(events: readonly EventRecord[]): string | null {
  const attempt = events.findLast((event) => event.type === "attempt.started");
  return attempt?.type === "attempt.started" ? attempt.stepId : null;
}

/** Every run ID under `runsDir`: a directory whose name is a run ID this tool could have made. */
async function listRunIds(runsDir: string): Promise<readonly string[]> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && isRunId(entry.name))
    .map((entry) => entry.name);
}
