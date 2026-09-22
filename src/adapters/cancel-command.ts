/**
 * `loopfile cancel <runid>`: stop a run (#63, ADR 0008).
 *
 * The command sends `cancel` on the run's control socket and waits for the run
 * owner to take it. The run owner stops the current attempt, writes
 * `attempt.interrupted` and `run.cancelled`, removes the socket and exits.
 * This command writes nothing to the run: it only reads the event log to name
 * an unknown or ended run, and waits for the socket file to go. Its answer is
 * an AXI confirmation block on stderr.
 */

import { readFile } from "node:fs/promises";
import {
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { parseEventLog, replay } from "../application/replay.ts";
import { loopfileHome, pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { requestCancel } from "./run-owner.ts";

const USAGE = "Usage: loopfile cancel <runid>";
const HELP = `${USAGE}

Ask the run owner to stop a run and end it as cancelled. Cancelling an already
ended run is successful and reports that it already ended. Exit 0 means the
request was accepted; an invalid call or unavailable owner returns 2.
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
  return await cancelCommandWork(argv, err, env, options);
}

async function cancelCommandWork(
  argv: readonly string[],
  err: Out,
  env: Record<string, string | undefined>,
  options: CancelOptions,
): Promise<number> {
  const runId = argv.length === 2 ? argv[1] : undefined;
  if (runId === undefined || runId.startsWith("-")) {
    err(
      renderOperatorFailure({
        summary: "cancel takes one run ID",
        code: "bad_argument",
        help: USAGE,
      }).stderr,
    );
    return 2;
  }
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
