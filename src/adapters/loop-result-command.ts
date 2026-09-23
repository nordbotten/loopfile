/** `loopfile result <loopid>`: collect a loop and every child run. */

import { readFile } from "node:fs/promises";
import { loopStatus } from "../application/loop-status.ts";
import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { CorruptEventLogError, parseEventLog } from "../application/replay.ts";
import { parseStatusProjection } from "../application/status.ts";
import type { LoopEvent, LoopRunStarted } from "../domain/events.ts";
import type { LoopStatus, StatusProjection } from "../domain/status.ts";
import { loopfileHome, loopPaths, pathExists, runPaths } from "./run-directory.ts";

type Out = (text: string) => void;
type Err = (text: string) => void;

interface LoopResultRun {
  readonly index: number;
  readonly runId: string;
  readonly inputSet: LoopRunStarted["inputSet"];
  readonly retryOf: string | null;
  readonly state: StatusProjection["state"] | "crashed";
  readonly endReason: string | null;
  readonly branch: string;
}

interface LoopResult {
  readonly loopId: string;
  readonly state: LoopStatus["state"];
  readonly endReason: LoopStatus["endReason"];
  readonly cancelMode: LoopStatus["cancelMode"];
  readonly detail: LoopStatus["detail"];
  readonly runs: readonly LoopResultRun[];
}

/** Reads and prints a loop result. */
export async function loopResultCommand(
  loopId: string,
  json: boolean,
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
): Promise<number> {
  let result: LoopResult | OperatorFailure;
  try {
    result = await readLoopResult(loopId, env);
  } catch (error) {
    result = {
      summary: `could not read result for loop ${loopId}${errorMessage(error)}`,
      code: "log_unreadable",
      help: "Check the loop folder, its events.jsonl and the child run status files.",
    };
  }
  if ("code" in result) {
    err(renderOperatorFailure(result).stderr);
    return 2;
  }

  out(json ? `${JSON.stringify(result)}\n` : renderLoopResult(result));
  if (result.state === "running") return 2;
  return result.state === "completed" ? 0 : 1;
}

async function readLoopResult(
  loopId: string,
  env: Record<string, string | undefined>,
): Promise<LoopResult | OperatorFailure> {
  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const paths = loopPaths(home, loopId);
  if (!(await pathExists(paths.root))) {
    return {
      summary: `no loop ${loopId}`,
      code: "no_such_loop",
      help: "Use `loopfile list` to find a valid loop ID.",
    };
  }

  let events: readonly LoopEvent[];
  try {
    events = parseEventLog<LoopEvent>(await readFile(paths.events, "utf8"));
  } catch (error) {
    return {
      summary: `events.jsonl for loop ${loopId} could not be read${errorMessage(error)}`,
      code: error instanceof CorruptEventLogError ? "log_corrupt" : "log_unreadable",
      help: "Check that events.jsonl exists and is readable.",
    };
  }

  const created = events[0];
  if (created?.type !== "loop.created" || created.loopId !== loopId) {
    return {
      summary: `events.jsonl for loop ${loopId} does not start with its loop.created event`,
      code: "log_corrupt",
      help: "Inspect events.jsonl before retrying the read.",
    };
  }

  const status = loopStatus(events);
  const startedRuns = events.filter(
    (event): event is LoopRunStarted => event.type === "loop.run_started",
  );
  const runs = await Promise.all(
    startedRuns.map(async (run) => {
      const child = await readChildStatus(home, run.runId, status.state);
      return {
        index: run.index,
        runId: run.runId,
        inputSet: run.inputSet,
        retryOf: run.retryOf,
        state: child.state,
        endReason: child.endReason,
        branch: `loopfile/${run.runId}`,
      };
    }),
  );

  return {
    loopId,
    state: status.state,
    endReason: status.endReason,
    cancelMode: status.cancelMode,
    detail: status.detail,
    runs,
  };
}

async function readChildStatus(
  home: string,
  runId: string,
  loopState: LoopStatus["state"],
): Promise<{ state: StatusProjection["state"] | "crashed"; endReason: string | null }> {
  try {
    const status = parseStatusProjection(
      JSON.parse(await readFile(runPaths(home, runId).status, "utf8")),
    );
    return { state: status.state, endReason: status.endReason };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return loopState === "running"
        ? { state: "running", endReason: null }
        : { state: "crashed", endReason: null };
    }
    throw error;
  }
}

function renderLoopResult(result: LoopResult): string {
  const ended = result.endReason ?? "not yet";
  const cancelMode = result.cancelMode === null ? "" : ` (${result.cancelMode})`;
  const detail =
    result.detail === null || result.detail === "" ? "" : ` - ${oneLine(result.detail)}`;
  const lines = [
    `loop: ${result.loopId}`,
    `state: ${result.state}`,
    `ended: ${ended}${cancelMode}${detail}`,
  ];
  for (const run of result.runs) {
    const inputSet = Object.entries(run.inputSet)
      .map(([name, value]) => `${oneLine(name)}=${oneLine(value)}`)
      .join(" ");
    lines.push(
      "",
      `run ${run.index}: ${run.runId}`,
      `  input set:${inputSet === "" ? "" : ` ${inputSet}`}`,
      `  state: ${run.state}`,
      `  end reason: ${run.endReason ?? "not yet"}`,
      `  branch: ${run.branch}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `: ${error.message}`.replace(/^: $/, "") : "";
}
