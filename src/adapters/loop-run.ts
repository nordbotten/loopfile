/** Runs a loop in-process, starting one detached child run at a time (#59). */

import { readFile, rename, writeFile } from "node:fs/promises";
import { loopStatus } from "../application/loop-status.ts";
import { type LastChild, nextLoopAction } from "../application/next-loop-action.ts";
import { parseEventLog } from "../application/replay.ts";
import { parseStatusProjection } from "../application/status.ts";
import type { LoopEvent } from "../domain/events.ts";
import type { LoopStatus } from "../domain/status.ts";
import { type EventLog, type NewEvent, openEventLog } from "./event-log.ts";
import { type StartRunOptions, type StartRunResult, startRun } from "./launch-command.ts";
import { loopPaths, newRunId, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

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
    for (;;) {
      const status = loopStatus(history);
      const child = await lastChild(home, status);
      const action = nextLoopAction(status, child);

      if (action.kind === "wait") {
        await waitForChild(home, status.currentRunId ?? status.runIds.at(-1) ?? "", deps.pollMs);
        continue;
      }
      if (action.kind === "end") {
        return await appendEnd(log, history, paths.status, action);
      }

      const runId = newRunId();
      const index = status.runs + 1;
      await appendLoopEvent(log, history, paths.status, {
        type: "loop.run_started",
        runId,
        index,
        inputSet: action.inputSet,
        sourceIndex: action.sourceIndex,
        retryOf: null,
      });

      const started = await startChildRun(deps, {
        source: paths.loopfile,
        sourceKind: "directory",
        repository: created.repositoryPath,
        inputs: action.inputSet,
        runId,
        loopId,
        loopIndex: index,
        cli: deps.cli,
        env: deps.env,
      });
      if (!started.ok) {
        return await appendEnd(log, history, paths.status, {
          kind: "end",
          reason: "internal_error",
          detail: started.failure.messages.join("; "),
        });
      }
      await waitForChild(home, runId, deps.pollMs);
    }
  } catch (error) {
    await appendInternalError(log, history, paths.status, error);
    throw error;
  } finally {
    await log.close();
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
  const alive = (await pingOwner(paths.socket)) === runId;
  return { state: alive ? "running" : "crashed", runId };
}

async function waitForChild(home: string, runId: string, pollMs = CHILD_POLL_MS): Promise<void> {
  for (;;) {
    if ((await childState(home, runId)).state !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function readChildStatus(path: string) {
  return await readFile(path, "utf8")
    .then((text) => parseStatusProjection(JSON.parse(text)))
    .catch(() => undefined);
}
