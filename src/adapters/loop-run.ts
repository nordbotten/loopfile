/** Runs a loop in-process, starting one detached child run at a time (#59, #63). */

import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseInputSet } from "../application/launch-inputs.ts";
import { loopStatus } from "../application/loop-status.ts";
import {
  type LastChild,
  type NextLoopActionOptions,
  type NextSourceResult,
  nextLoopAction,
} from "../application/next-loop-action.ts";
import { parseEventLog } from "../application/replay.ts";
import { parseStatusProjection } from "../application/status.ts";
import type { LoopCancelMode, LoopEvent, LoopSource } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import type { LoopStatus } from "../domain/status.ts";
import { loadDirectory } from "./directory-loader.ts";
import { type EventLog, type NewEvent, openEventLog } from "./event-log.ts";
import { type StartRunOptions, type StartRunResult, startRun } from "./launch-command.ts";
import { programIdentity } from "./program-identity.ts";
import { loopPaths, newRunId, runPaths } from "./run-directory.ts";
import { pingOwner, requestCancel } from "./run-owner.ts";

/** Inputs the in-process loop driver needs from its caller. */
export interface RunLoopDeps {
  /** The CLI program used to start every child run. */
  readonly cli: string;
  /** The loop owner's environment, passed unchanged to every child owner. */
  readonly env: Record<string, string | undefined>;
  /** Overridable for tests and for another owner implementation. */
  readonly startRun?: (options: StartRunOptions) => Promise<StartRunResult>;
  /** Overridable for tests; production checks children every 500 ms. */
  readonly pollMs?: number;
  /** Requests made on the loop owner's control socket. */
  readonly cancelRequests?: LoopCancelRequests;
}

export interface LoopCancelRequests {
  request(mode: LoopCancelMode): Promise<boolean>;
  take(): { readonly mode: LoopCancelMode; acknowledge(): void } | undefined;
  hasPending(): boolean;
  wait(): Promise<void>;
  close(): void;
}

/** Holds one loop cancellation request until the driver has recorded it. */
export function createLoopCancelRequests(): LoopCancelRequests {
  let mode: LoopCancelMode | undefined;
  let taken = false;
  let closed = false;
  let acknowledged = false;
  let resolveRequest: (accepted: boolean) => void = () => undefined;
  const response = new Promise<boolean>((resolve) => {
    resolveRequest = resolve;
  });
  let wake!: () => void;
  const notified = new Promise<void>((resolve) => {
    wake = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    request(requestedMode) {
      if (closed) return Promise.resolve(false);
      if (mode !== undefined) return mode === requestedMode ? response : Promise.resolve(false);
      mode = requestedMode;
      wake();
      return response;
    },
    take() {
      if (mode === undefined || taken) return undefined;
      taken = true;
      return {
        mode,
        acknowledge() {
          if (acknowledged) return;
          acknowledged = true;
          resolveRequest(true);
        },
      };
    },
    hasPending() {
      return mode !== undefined && !taken;
    },
    wait() {
      return taken ? finished : notified;
    },
    close() {
      closed = true;
      if (!acknowledged) resolveRequest(false);
      wake();
      finish();
    },
  };
}

const CHILD_POLL_MS = 500;

/** Runs the loop represented by the existing `loop.created` event. */
export async function runLoop(
  home: string,
  loopId: string,
  deps: RunLoopDeps,
): Promise<LoopStatus> {
  const paths = loopPaths(home, loopId);
  const history = [...parseEventLog<LoopEvent>(await readFile(paths.events, "utf8"))];
  const created = history[0];
  if (created?.type !== "loop.created") {
    throw new Error("loop events.jsonl does not start with loop.created");
  }

  await writeLoopStatus(paths.status, history);
  if (loopStatus(history).state !== "running") return loopStatus(history);

  const log = await openEventLog<LoopEvent>(paths.events);
  try {
    const workflow =
      created.source.kind === "next" ? await loadNextWorkflow(paths.loopfile) : undefined;
    return await driveLoop({
      home,
      loopId,
      created,
      workflow,
      deps,
      log,
      history,
      loopfilePath: paths.loopfile,
      statusPath: paths.status,
    });
  } catch (error) {
    await appendInternalError(log, history, paths.status, error);
    throw error;
  } finally {
    await log.close();
    deps.cancelRequests?.close();
  }
}

async function startChildRun(deps: RunLoopDeps, options: StartRunOptions): Promise<StartRunResult> {
  return await (deps.startRun ?? startRun)(options);
}

async function appendInternalError(
  log: EventLog<LoopEvent>,
  history: LoopEvent[],
  statusPath: string,
  error: unknown,
): Promise<void> {
  if (history.at(-1)?.type === "loop.ended") return;
  await appendLoopEvent(log, history, statusPath, {
    type: "loop.ended",
    result: "failure",
    reason: "internal_error",
    detail: String(error),
  }).catch(() => undefined);
}

interface LoopDriver {
  readonly home: string;
  readonly loopId: string;
  readonly created: Extract<LoopEvent, { readonly type: "loop.created" }>;
  readonly workflow: Workflow | undefined;
  readonly deps: RunLoopDeps;
  readonly log: EventLog<LoopEvent>;
  readonly history: LoopEvent[];
  readonly loopfilePath: string;
  readonly statusPath: string;
}

async function driveLoop(driver: LoopDriver): Promise<LoopStatus> {
  for (;;) {
    if (await recordCancellation(driver)) continue;
    const status = loopStatus(driver.history);
    await waitForPause(
      status.cancelRequested === null ? status.pausedUntil : null,
      driver.deps.cancelRequests,
    );
    const child = await lastChild(driver.home, status);
    const action = await nextAction(
      status,
      child,
      driver.created.source,
      driver.created.repositoryPath,
      driver.deps.env,
      driver.loopId,
      driver.workflow,
      driver.history,
      driver.created.pauseMs,
    );
    if (driver.deps.cancelRequests?.hasPending()) continue;
    const ended = await performLoopAction(action, status, driver);
    if (ended !== undefined) return ended;
  }
}

async function recordCancellation(driver: LoopDriver): Promise<boolean> {
  const cancellation = driver.deps.cancelRequests?.take();
  if (cancellation === undefined) return false;
  await appendLoopEvent(driver.log, driver.history, driver.statusPath, {
    type: "loop.cancel_requested",
    mode: cancellation.mode,
  });
  cancellation.acknowledge();
  const child = await lastChild(driver.home, loopStatus(driver.history));
  if (cancellation.mode === "now" && child.state === "running") {
    await requestCancel(runPaths(driver.home, child.runId).socket, child.runId);
  }
  return true;
}

async function performLoopAction(
  action: ReturnType<typeof nextLoopAction>,
  status: LoopStatus,
  driver: LoopDriver,
): Promise<LoopStatus | undefined> {
  if (action.kind === "wait") {
    await waitForChild(
      driver.home,
      currentRunId(status),
      driver.deps.pollMs,
      driver.deps.cancelRequests,
    );
    return undefined;
  }
  if (action.kind === "pause") {
    await appendLoopEvent(driver.log, driver.history, driver.statusPath, {
      type: "loop.paused",
      until: action.until,
    });
    return undefined;
  }
  if (action.kind === "end") {
    return await appendEnd(driver.log, driver.history, driver.statusPath, action);
  }
  return await startNextChild(action, status, driver);
}

async function startNextChild(
  action: Extract<ReturnType<typeof nextLoopAction>, { readonly kind: "start" }>,
  status: LoopStatus,
  driver: LoopDriver,
): Promise<LoopStatus | undefined> {
  const currentProgram = await programIdentity(driver.deps.cli);
  if (driver.deps.cancelRequests?.hasPending()) return undefined;
  if (
    currentProgram.version !== driver.created.program.version ||
    currentProgram.digest !== driver.created.program.digest
  ) {
    return await appendEnd(driver.log, driver.history, driver.statusPath, {
      kind: "end",
      reason: "program_changed",
      detail: `loopfile changed from ${driver.created.program.version} to ${currentProgram.version}`,
    });
  }

  const runId = newRunId();
  const index = status.runs + 1;
  await appendLoopEvent(driver.log, driver.history, driver.statusPath, {
    type: "loop.run_started",
    runId,
    index,
    inputSet: action.inputSet,
    sourceIndex: action.sourceIndex,
    retryOf: action.retryOf ?? null,
  });
  const started = await startChildRun(driver.deps, {
    source: driver.loopfilePath,
    sourceKind: "directory",
    repository: driver.created.repositoryPath,
    inputs: action.inputSet,
    runId,
    loopId: driver.loopId,
    loopIndex: index,
    cli: driver.deps.cli,
    env: driver.deps.env,
  });
  if (!started.ok) {
    return await appendEnd(driver.log, driver.history, driver.statusPath, {
      kind: "end",
      reason: "internal_error",
      detail: started.failure.messages.join("; "),
    });
  }
  await waitForChild(driver.home, runId, driver.deps.pollMs, driver.deps.cancelRequests);
  return undefined;
}

async function appendEnd(
  log: EventLog<LoopEvent>,
  history: LoopEvent[],
  statusPath: string,
  action: Extract<ReturnType<typeof nextLoopAction>, { readonly kind: "end" }>,
): Promise<LoopStatus> {
  await appendLoopEvent(log, history, statusPath, {
    type: "loop.ended",
    result:
      action.reason === "source_empty" || action.reason === "max_runs" ? "success" : "failure",
    reason: action.reason,
    ...(action.cancelMode === undefined ? {} : { cancelMode: action.cancelMode }),
    ...(action.detail === undefined ? {} : { detail: action.detail }),
  });
  return loopStatus(history);
}

async function appendLoopEvent(
  log: EventLog<LoopEvent>,
  history: LoopEvent[],
  statusPath: string,
  event: NewEvent<LoopEvent>,
): Promise<void> {
  const written = await log.append(event);
  history.push(written);
  await writeLoopStatus(statusPath, history);
}

async function writeLoopStatus(statusPath: string, events: readonly LoopEvent[]): Promise<void> {
  const temporary = `${statusPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(loopStatus(events))}\n`);
  await rename(temporary, statusPath);
}

async function nextAction(
  status: LoopStatus,
  child: LastChild,
  source: LoopSource,
  repositoryPath: string,
  ownerEnv: Record<string, string | undefined>,
  loopId: string,
  workflow: Workflow | undefined,
  history: readonly LoopEvent[],
  pauseMs: number | null,
): Promise<ReturnType<typeof nextLoopAction>> {
  const options: NextLoopActionOptions = { pauseMs };
  if (status.maxRuns !== null && status.runs >= status.maxRuns) {
    return nextLoopAction(status, child, source, undefined, workflow, history, options);
  }
  const action = nextLoopAction(status, child, source, undefined, workflow, history, options);
  if (source.kind !== "next" || action.kind !== "end" || action.reason !== "source_failed") {
    return action;
  }
  const nextResult = await nextResultFor(source, child, repositoryPath, ownerEnv, loopId);
  return nextLoopAction(status, child, source, nextResult, workflow, history, options);
}

async function nextResultFor(
  source: LoopSource,
  child: LastChild,
  repositoryPath: string,
  ownerEnv: Record<string, string | undefined>,
  loopId: string,
): Promise<NextSourceResult | undefined> {
  if (source.kind !== "next") return undefined;
  if (child.state !== "none" && child.state !== "completed") return undefined;
  return await runNextCommand(source.command, repositoryPath, ownerEnv, loopId);
}

async function loadNextWorkflow(path: string): Promise<Workflow> {
  const loaded = await loadDirectory(path);
  if (loaded.status !== "loaded") throw new Error("the materialized Loopfile cannot be loaded");
  return loaded.workflow;
}

function runNextCommand(
  command: string,
  repositoryPath: string,
  ownerEnv: Record<string, string | undefined>,
  loopId: string,
): Promise<NextSourceResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: repositoryPath,
      env: { ...ownerEnv, LOOPFILE_LOOP_ID: loopId },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    let settled = false;
    const finish = (result: NextSourceResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      finish({ kind: "output", result: { ok: false, messages: [error.message] } });
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish({
          kind: "output",
          result: { ok: false, messages: [`--next exited ${String(code)}`] },
        });
      } else if (output.trim() === "") {
        finish({ kind: "empty" });
      } else {
        finish({ kind: "output", result: parseInputSet(output.trim()) });
      }
    });
  });
}

async function waitForPause(
  until: string | null,
  cancelRequests: LoopCancelRequests | undefined,
): Promise<void> {
  if (until === null) return;
  const delay = Date.parse(until) - Date.now();
  if (delay > 0) await waitForDelayOrCancel(delay, cancelRequests);
}

async function waitForDelayOrCancel(
  delay: number,
  cancelRequests: LoopCancelRequests | undefined,
): Promise<void> {
  if (cancelRequests === undefined) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, delay);
    }),
    cancelRequests.wait(),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function currentRunId(status: LoopStatus): string {
  return status.currentRunId ?? status.runIds.at(-1) ?? "";
}

async function lastChild(home: string, status: LoopStatus): Promise<LastChild> {
  const runId = status.currentRunId ?? status.runIds.at(-1);
  if (runId === undefined) return { state: "none" };

  return await childState(home, runId);
}

async function childState(home: string, runId: string): Promise<LastChild> {
  const paths = runPaths(home, runId);
  const childStatus = await readChildStatus(paths.status);
  if (childStatus !== undefined && childStatus.state !== "running") {
    return { state: childStatus.state, runId };
  }
  if ((await pingOwner(paths.socket)) === runId) return { state: "running", runId };
  // The run may have ended while the ping waited: its owner writes the final
  // status before it closes the socket, so read the status again before
  // calling the run crashed.
  const final = await readChildStatus(paths.status);
  if (final !== undefined && final.state !== "running") return { state: final.state, runId };
  return { state: "crashed", runId };
}

async function waitForChild(
  home: string,
  runId: string,
  pollMs = CHILD_POLL_MS,
  cancelRequests?: LoopCancelRequests,
): Promise<void> {
  for (;;) {
    if ((await childState(home, runId)).state !== "running" || cancelRequests?.hasPending()) return;
    await waitForDelayOrCancel(pollMs, cancelRequests);
  }
}

async function readChildStatus(path: string) {
  return await readFile(path, "utf8")
    .then((text) => parseStatusProjection(JSON.parse(text)))
    .catch(() => undefined);
}
