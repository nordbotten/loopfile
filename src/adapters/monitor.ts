/**
 * `attachMonitor`: the live terminal monitor for one run (#49).
 *
 * Read-only. It reads `status.json`, pings `owner.sock` and the last
 * `owner.started` host once, and reads keys. It never writes a run file, a
 * socket message other than the ping, or an event, and it never reads
 * `events.jsonl` beyond that one host lookup. `d` and `Ctrl+C` detach; the run
 * goes on. Every other key does nothing, so nothing here can cancel a run.
 *
 * It redraws in place and never uses the alternate screen, so the final view
 * stays on screen when the run ends.
 */

import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { clearScreenDown, emitKeypressEvents, type Key, moveCursor } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { type MonitorView, notTerminalMessage, renderMonitor } from "../application/monitor.ts";
import type { OperatorFailure } from "../application/operator-error.ts";
import { endedExitCode } from "../application/run-end.ts";
import { parseStatusProjection } from "../application/status.ts";
import { unknownRunMessage } from "../application/tail.ts";
import type { RunId } from "../domain/model.ts";
import type { StatusProjection } from "../domain/status.ts";
import { loopfileHome, pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { lastOwnerStartedHost } from "./run-discovery.ts";
import { pingOwner } from "./run-owner.ts";

const DEFAULT_POLL_INTERVAL_MS = 500;

export interface MonitorIo {
  readonly input: Readable & { readonly isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  readonly output: Writable & { readonly isTTY?: boolean };
}

/** Overridable for tests only, the same as `TailOptions`. */
export interface MonitorOptions {
  readonly pollIntervalMs?: number;
  readonly ownerPingTimeoutMs?: number;
  readonly now?: () => Date;
  /** Operator callers turn monitor read failures into their stderr contract. */
  readonly onReadError?: (failure: OperatorFailure) => void;
}

/** Whether a person can use the monitor: both stdin and stdout are a terminal. */
export function hasTerminal({ input, output }: MonitorIo): boolean {
  return input.isTTY === true && output.isTTY === true;
}

/** Returns the process exit code. */
export async function attachMonitor(
  runId: RunId,
  io: MonitorIo,
  env: Record<string, string | undefined>,
  options: MonitorOptions = {},
): Promise<number> {
  const { input, output } = io;
  if (!hasTerminal(io)) {
    output.write(`error: ${notTerminalMessage(runId)}\n`);
    return 1;
  }
  const paths = runPaths(loopfileHome(env as NodeJS.ProcessEnv), runId);
  if (!(await pathExists(paths.root))) {
    const failure: OperatorFailure = {
      summary: unknownRunMessage(runId),
      code: "no_such_run",
      help: "Use `loopfile list` to find a valid run ID.",
    };
    if (options.onReadError !== undefined) {
      options.onReadError(failure);
      return 2;
    }
    output.write(`error: ${failure.summary}\n`);
    return 1;
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const otherHost = await ownedByOtherHost(paths.events);

  let lastFrameLines = 0;
  const draw = (view: MonitorView): void => {
    const frame = renderMonitor(view, now().toISOString());
    moveCursor(output, 0, -lastFrameLines);
    clearScreenDown(output);
    output.write(frame);
    lastFrameLines = frame.split("\n").length - 1;
  };

  const observe = (): Promise<Observation> =>
    observeRun(runId, paths, otherHost, options.ownerPingTimeoutMs);

  return await new Promise<number>((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number, text?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.setRawMode?.(false);
      input.off("keypress", onKeypress);
      input.pause();
      if (text !== undefined) output.write(text);
      resolve(code);
    };

    const onKeypress = (_text: string | undefined, key: Key | undefined): void => {
      if (key === undefined) return;
      const plain = key.ctrl !== true && key.meta !== true;
      const detach = (key.name === "d" && plain) || (key.ctrl === true && key.name === "c");
      if (detach) finish(0, "\n");
    };

    const tick = async (): Promise<void> => {
      try {
        const { view, exit } = await observe();
        if (finished) return;
        draw(view);
        if (exit !== undefined) return finish(exit);
      } catch (error) {
        if (options.onReadError !== undefined) {
          options.onReadError({
            summary: error instanceof Error && error.message ? error.message : String(error),
            code: "log_unreadable",
            help: "Check the run folder and its status.json.",
          });
          return finish(2);
        }
        return finish(1, `error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      timer = setTimeout(() => void tick(), pollIntervalMs);
    };

    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKeypress);
    void tick();
  });
}

/** What one tick saw: the view, and the exit code when it is the last tick. */
interface Observation {
  readonly view: MonitorView;
  readonly exit: number | undefined;
}

/**
 * Waits with no screen until the run ends or its owner is gone (#184), for a
 * caller with no terminal. The run is on this host: it was just started here.
 */
export async function waitForRun(
  runId: RunId,
  env: Record<string, string | undefined>,
  options: MonitorOptions = {},
): Promise<Observation & { readonly exit: number }> {
  const paths = runPaths(loopfileHome(env as NodeJS.ProcessEnv), runId);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  for (;;) {
    const { view, exit } = await observeRun(runId, paths, false, options.ownerPingTimeoutMs);
    if (exit !== undefined) return { view, exit };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** The view for one tick, and whether it is the last one. */
async function observeRun(
  runId: RunId,
  paths: RunPaths,
  otherHost: boolean,
  pingTimeoutMs: number | undefined,
): Promise<Observation> {
  const status = await readStatus(paths.status);
  const ended = endedObservation(status);
  if (ended) return ended;
  if (otherHost && status !== undefined) {
    return { view: { kind: "unknown", status }, exit: undefined };
  }
  return await pingObservation(runId, paths, status, pingTimeoutMs);
}

/** The final observation for a run whose `status.json` says it ended, else `undefined`. */
function endedObservation(status: StatusProjection | undefined): Observation | undefined {
  if (status === undefined || status.state === "running") return undefined;
  return { view: { kind: "ended", status }, exit: endedExitCode(status) };
}

/**
 * Ping the owner for a run `status.json` still calls running. A run may end
 * while the ping waits, so a dead owner re-reads the file before it is called
 * crashed.
 */
async function pingObservation(
  runId: RunId,
  paths: RunPaths,
  status: StatusProjection | undefined,
  timeoutMs: number | undefined,
): Promise<Observation> {
  const answer = await pingOwner(paths.socket, timeoutMs);
  if (answer === runId) {
    const view: MonitorView =
      status === undefined ? { kind: "waiting", runId } : { kind: "live", status };
    return { view, exit: undefined };
  }
  const again = await readStatus(paths.status);
  return endedObservation(again) ?? { view: { kind: "crashed", runId, status: again }, exit: 2 };
}

/** Whether the last `owner.started` names a host that is not this one (ADR 0008). */
async function ownedByOtherHost(eventsPath: string): Promise<boolean> {
  const host = await lastOwnerStartedHost(eventsPath);
  return host !== undefined && host !== hostname();
}

async function readStatus(path: string): Promise<StatusProjection | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return text === undefined ? undefined : parseStatusProjection(JSON.parse(text));
}
