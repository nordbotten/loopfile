/**
 * `loopfile cancel <runid>` stops a run; `cancel <loopid> --now|--after-run` stops a loop.
 *
 * A run cancel uses the run owner's socket; a loop cancel asks its owner to
 * record the mode and, for `--now`, cancel the current child. Both answers are
 * AXI confirmation blocks on stderr.
 */

import { readFile } from "node:fs/promises";
import {
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { parseEventLog, replay } from "../application/replay.ts";
import type { LoopCancelMode, LoopEvent } from "../domain/events.ts";
import { loopfileHome, loopPaths, pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { requestCancel, requestLoopCancel } from "./run-owner.ts";

const USAGE = "Usage: loopfile cancel <runid|loopid> [--now|--after-run]";
const LOOP_MODE_HELP = "Choose a loop cancellation mode with --now or --after-run.";
const HELP = `${USAGE}

Cancel a run, or choose whether to cancel a loop now or after its current run.
Cancelling an already ended item is successful and reports that it already ended.
Exit 0 means the request was accepted; an invalid call or unavailable owner returns 2.
`;

/** How long the command waits for the run owner to remove its socket (ADR 0008). */
export const CANCEL_WAIT_MS = 15_000;

/** Overridable for tests only. */
export interface CancelOptions {
  /** How long the run owner has to answer `cancel`. */
  readonly answerTimeoutMs?: number;
  /** How long to wait for the socket file to go. */
  readonly waitMs?: number;
}

type Out = (text: string) => void;

/** Runs `argv`, which starts with `cancel`. Returns the exit code. */
export async function cancelCommand(
  argv: readonly string[],
  out: Out,
  err: Out,
  env: Record<string, string | undefined>,
  options: CancelOptions = {},
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  if (argv[1]?.startsWith("loop-")) return await cancelLoopCommandWork(argv, err, env, options);
  return await cancelCommandWork(argv, err, env, options);
}

async function cancelLoopCommandWork(
  argv: readonly string[],
  err: Out,
  env: Record<string, string | undefined>,
  options: CancelOptions,
): Promise<number> {
  const args = loopCancelArgs(argv, err);
  if (args === undefined) return 2;
  const { loopId, mode } = args;
  const paths = loopPaths(loopfileHome(env as NodeJS.ProcessEnv), loopId);
  if (!(await pathExists(paths.root))) {
    err(
      renderOperatorFailure({
        summary: `no loop ${loopId}`,
        code: "no_such_loop",
        help: "Use `loopfile list` to find a valid loop ID.",
      }).stderr,
    );
    return 2;
  }
  if (await loopHasEnded(paths.events)) {
    err(renderOperatorConfirmation({ ended: loopId, code: "already_ended" }));
    return 0;
  }
  if (!(await requestLoopCancel(paths.socket, loopId, mode, options.answerTimeoutMs))) {
    if (await loopHasEnded(paths.events)) {
      err(renderOperatorConfirmation({ ended: loopId, code: "already_ended" }));
      return 0;
    }
    err(
      renderOperatorFailure({
        summary: `the loop owner of loop ${loopId} does not answer`,
        code: "owner_gone",
        help: `A crashed loop needs no cancel; \`loopfile resume ${loopId}\` goes on with it.`,
      }).stderr,
    );
    return 2;
  }
  await socketGone(paths.socket, options.waitMs ?? CANCEL_WAIT_MS);
  err(renderOperatorConfirmation({ cancelled: `${loopId} (${mode})` }));
  return 0;
}

function loopCancelArgs(
  argv: readonly string[],
  err: Out,
): { readonly loopId: string; readonly mode: LoopCancelMode } | undefined {
  const loopId = argv[1];
  const modeFlag = argv[2];
  const mode: LoopCancelMode | undefined =
    modeFlag === "--now" ? "now" : modeFlag === "--after-run" ? "after_run" : undefined;
  if (loopId !== undefined && mode !== undefined && argv.length === 3) return { loopId, mode };
  err(
    renderOperatorFailure({
      summary: `cancel requires ${LOOP_MODE_HELP}`,
      code: "bad_argument",
      help: USAGE,
    }).stderr,
  );
  return undefined;
}

async function loopHasEnded(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  try {
    return parseEventLog<LoopEvent>(text).at(-1)?.type === "loop.ended";
  } catch {
    return false;
  }
}

async function cancelCommandWork(
  argv: readonly string[],
  err: Out,
  env: Record<string, string | undefined>,
  options: CancelOptions,
): Promise<number> {
  const runId = runCancelId(argv, err);
  if (runId === undefined) return 2;
  const paths = runPaths(loopfileHome(env as NodeJS.ProcessEnv), runId);
  if (!(await pathExists(paths.root))) {
    err(
      renderOperatorFailure({
        summary: `no run ${runId}`,
        code: "no_such_run",
        help: "Use `loopfile list` to find a valid run ID.",
      }).stderr,
    );
    return 2;
  }
  if (await hasEnded(paths)) {
    err(renderOperatorConfirmation({ ended: runId, code: "already_ended" }));
    return 0;
  }
  if (!(await requestCancel(paths.socket, runId, options.answerTimeoutMs))) {
    err(
      renderOperatorFailure({
        summary: `the run owner of run ${runId} does not answer`,
        code: "owner_gone",
        help: `A crashed run needs no cancel; \`loopfile resume ${runId}\` goes on with it.`,
      }).stderr,
    );
    return 2;
  }
  const gone = await socketGone(paths.socket, options.waitMs ?? CANCEL_WAIT_MS);
  err(renderOperatorConfirmation({ [gone ? "cancelled" : "cancelling"]: runId }));
  return 0;
}

function runCancelId(argv: readonly string[], err: Out): string | undefined {
  const runId = argv.length === 2 ? argv[1] : undefined;
  if (runId !== undefined && !runId.startsWith("-")) return runId;
  err(
    renderOperatorFailure({
      summary: "cancel takes one run ID",
      code: "bad_argument",
      help: USAGE,
    }).stderr,
  );
  return undefined;
}

/** Whether the run already has an end event. */
async function hasEnded(paths: RunPaths): Promise<boolean> {
  const text = await readFile(paths.events, "utf8").catch(() => undefined);
  return text === undefined ? false : endOf(text) !== undefined;
}

/**
 * How the log says the run ended, or nothing. A log this cannot read is left
 * to the run owner: if one answers, it can still be cancelled.
 */
function endOf(text: string) {
  try {
    return replay(parseEventLog(text)).result;
  } catch {
    return undefined;
  }
}

/** Waits until `path` is gone. False when it is still there after `waitMs`. */
async function socketGone(path: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (await pathExists(path)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
