/**
 * `loopfile interrupt <runid>`: stop the current attempt without ending the run (#53).
 *
 * The command asks the live run owner to stop its attempt. The owner is the
 * only writer of `attempt.interrupted`; this command only reads the log to
 * reject ended runs and waits for the next attempt (or attempt limit).
 */

import { readFile } from "node:fs/promises";
import {
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { parseEventLog } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import { loopfileHome, pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { requestInterrupt } from "./run-owner.ts";

const USAGE = "Usage: loopfile interrupt <runid>";
const HELP = `${USAGE}

Stop the current attempt and start a new attempt of the same step. The
interrupted attempt counts toward maxAttempts. Interrupting an ended or crashed
run fails; use loopfile resume for a crashed run.
`;

/** How long the command waits for the owner to start the replacement attempt. */
export const INTERRUPT_WAIT_MS = 15_000;

/** Overridable for tests only. */
export interface InterruptOptions {
  /** How long the run owner has to answer. */
  readonly answerTimeoutMs?: number;
  /** How long to wait for the replacement attempt. */
  readonly waitMs?: number;
}

type Out = (text: string) => void;

/** Runs `argv`, which starts with `interrupt`. Returns the exit code. */
export async function interruptCommand(
  argv: readonly string[],
  out: Out,
  err: Out,
  env: Record<string, string | undefined>,
  options: InterruptOptions = {},
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const target = await interruptTarget(argv, err, env);
  if (target === undefined) return 2;

  const requested = await requestInterrupt(
    target.paths.socket,
    target.runId,
    options.answerTimeoutMs,
  );
  if (requested === undefined) {
    err(
      renderOperatorFailure({
        summary: `the run owner of run ${target.runId} does not answer`,
        code: "owner_gone",
        help: `The run crashed; continue it with \`loopfile resume ${target.runId}\`.`,
      }).stderr,
    );
    return 2;
  }
  if (!requested) {
    err(
      renderOperatorFailure({
        summary: "no attempt is running",
        code: "operation_failed",
        help: "Retry `loopfile interrupt` while the run has an active attempt.",
      }).stderr,
    );
    return 2;
  }

  const replaced = await waitForReplacement(
    target.paths,
    target.events.at(-1)?.seq ?? 0,
    options.waitMs ?? INTERRUPT_WAIT_MS,
  );
  err(renderOperatorConfirmation({ [replaced ? "interrupted" : "interrupting"]: target.runId }));
  return 0;
}

type InterruptTarget = {
  readonly runId: string;
  readonly paths: RunPaths;
  readonly events: readonly RunEvent[];
};

async function interruptTarget(
  argv: readonly string[],
  err: Out,
  env: Record<string, string | undefined>,
): Promise<InterruptTarget | undefined> {
  const runId = argv.length === 2 ? argv[1] : undefined;
  if (runId === undefined || runId.startsWith("-")) {
    err(
      renderOperatorFailure({
        summary: "interrupt takes one run ID",
        code: "bad_argument",
        help: USAGE,
      }).stderr,
    );
    return undefined;
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
    return undefined;
  }

  const events = await readEvents(paths);
  if (events === undefined) {
    err(
      renderOperatorFailure({
        summary: `events.jsonl for run ${runId} could not be opened`,
        code: "log_unreadable",
        help: "Check that events.jsonl exists and is readable.",
      }).stderr,
    );
    return undefined;
  }
  if (events.some((event) => event.type === "run.ended" || event.type === "run.cancelled")) {
    err(
      renderOperatorFailure({
        summary: `run ${runId} has ended`,
        code: "already_ended",
        help: "Interrupt only a running run with an active attempt.",
      }).stderr,
    );
    return undefined;
  }
  return { runId, paths, events };
}

async function readEvents(paths: RunPaths) {
  return await readFile(paths.events, "utf8")
    .then(parseEventLog)
    .catch(() => undefined);
}

/** Waits until the interrupted attempt has been replaced or hit maxAttempts. */
async function waitForReplacement(
  paths: RunPaths,
  lastSeq: number,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const advanced = await readFile(paths.events, "utf8")
      .then(parseEventLog)
      .catch(() => []);
    if (
      advanced.some(
        (event) =>
          event.seq > lastSeq &&
          (event.type === "attempt.started" ||
            event.type === "run.ended" ||
            event.type === "run.cancelled"),
      )
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
