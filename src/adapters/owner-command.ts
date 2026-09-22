/**
 * `loopfile __owner <runid>`: the hidden command that is a run owner (#115).
 *
 * The CLI spawns it detached, with stdout and stderr redirected to
 * `owner.log`, and waits on the control socket for "ready" (ADR 0008). That
 * spawn is #35; this is the other end of it.
 *
 * The CLI hands over what to run in `LOOPFILE_LAUNCH` (#35): the source, the
 * target repository and the inputs. With it the command runs the workflow to its
 * end (`workflow-run.ts`, #116). Without it the run owner only starts, says who
 * it is and waits to be stopped. With `LOOPFILE_RESUME` set by `loopfile
 * resume` it goes on with a crashed run instead (#64).
 *
 * SIGTERM, SIGINT or SIGHUP to the run owner cancels the run, the same way
 * `loopfile cancel` does (#63, ADR 0008).
 */

import { decodeLaunch, LAUNCH_ENV, type LaunchRequest } from "../application/launch-inputs.ts";
import { localExecutor } from "./local-executor.ts";
import { loopfileHome } from "./run-directory.ts";
import { RunOwnerError, startRunOwner } from "./run-owner.ts";
import { executeRun, resumeRun } from "./workflow-run.ts";

/** Set by `loopfile resume` (#64): the run owner goes on with a crashed run instead of starting one. */
export const RESUME_ENV = "LOOPFILE_RESUME";

/** Runs a run owner to its end, and returns the process exit code. */
export async function ownerCommand(
  args: readonly string[],
  err: (text: string) => void,
  env: Record<string, string | undefined>,
): Promise<number> {
  const runId = args[0];
  if (runId === undefined || runId === "") {
    err("loopfile: __owner needs a run ID\n");
    return 2;
  }

  const launch = launchOf(env);
  if (launch === "invalid") {
    err(`loopfile: ${LAUNCH_ENV} is not a launch request\n`);
    return 2;
  }

  try {
    await whileSignalsCancel((cancelSignal) => runOwner(runId, launch, env, cancelSignal));
    return 0;
  } catch (error) {
    // A run owner writes to `owner.log`, which is the only place its errors
    // are read, so the message has to carry the reason on its own.
    err(`loopfile: ${reasonOf(error)}\n`);
    return 1;
  }
}

/** The signals that cancel a run, as `loopfile cancel` does (ADR 0008). */
const CANCEL_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/** Runs `body` with a signal that aborts when the process gets one of `CANCEL_SIGNALS`. */
async function whileSignalsCancel(body: (cancelSignal: AbortSignal) => Promise<void>) {
  const cancel = new AbortController();
  const onSignal = () => cancel.abort();
  for (const signal of CANCEL_SIGNALS) process.on(signal, onSignal);
  try {
    await body(cancel.signal);
  } finally {
    for (const signal of CANCEL_SIGNALS) process.off(signal, onSignal);
  }
}

/** Resumes a crashed run, runs a launched one, or only holds the socket. */
function runOwner(
  runId: string,
  launch: LaunchRequest | undefined,
  env: Record<string, string | undefined>,
  cancelSignal: AbortSignal,
): Promise<void> {
  if (env[RESUME_ENV] !== undefined) return runResumed(runId, env, cancelSignal);
  if (launch !== undefined) return runLaunched(runId, launch, env, cancelSignal);
  return waitUntilStopped(runId, env, cancelSignal);
}

/** The request the CLI handed over, nothing when it handed none, `invalid` when it is not one. */
function launchOf(env: Record<string, string | undefined>): LaunchRequest | "invalid" | undefined {
  const text = env[LAUNCH_ENV];
  if (text === undefined) return undefined;
  return decodeLaunch(text) ?? "invalid";
}

function reasonOf(error: unknown): string {
  return error instanceof RunOwnerError ? error.message : String(error);
}

/** Runs the launched workflow to its end. */
async function runLaunched(
  runId: string,
  launch: LaunchRequest,
  env: Record<string, string | undefined>,
  cancelSignal: AbortSignal,
): Promise<void> {
  // A step must not read the request: its inputs are read as `input.<name>`.
  const stepEnv = { ...env };
  delete stepEnv[LAUNCH_ENV];
  await executeRun({
    home: loopfileHome(env),
    runId,
    source: launch.source,
    sourceKind: launch.kind,
    sourceText: launch.sourceText,
    inputs: launch.inputs,
    loopId: launch.loopId,
    loopIndex: launch.loopIndex,
    repository: launch.repository,
    executor: localExecutor(stepEnv),
    cancelSignal,
  });
}

/** Goes on with a crashed run to its end. */
async function runResumed(
  runId: string,
  env: Record<string, string | undefined>,
  cancelSignal: AbortSignal,
): Promise<void> {
  const stepEnv = { ...env };
  delete stepEnv[RESUME_ENV];
  delete stepEnv[LAUNCH_ENV];
  await resumeRun({
    home: loopfileHome(env),
    runId,
    executor: localExecutor(stepEnv),
    cancelSignal,
  });
}

/** Starts the run owner with nothing to run and holds it until it is stopped or cancelled. */
async function waitUntilStopped(
  runId: string,
  env: Record<string, string | undefined>,
  cancelSignal: AbortSignal,
): Promise<void> {
  const owner = await startRunOwner({ home: loopfileHome(env), runId, cancelSignal });
  const cancelled = new Promise((resolve) =>
    owner.cancelled.addEventListener("abort", resolve, { once: true }),
  );
  if (!owner.cancelled.aborted) await Promise.race([owner.stopped, cancelled]);
  await owner.close();
}
