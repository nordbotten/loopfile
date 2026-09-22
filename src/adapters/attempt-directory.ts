/**
 * The attempt folder: where one visit to a step keeps everything it produced (#15).
 *
 * Every attempt gets `runs/<runid>/attempts/<nnn>-<step>/`, made before
 * `attempt.started` and never written to again after `attempt.ended` or
 * `attempt.interrupted`. A folder is never reused: a new visit to a step, a
 * retry through `onFailure` and a resume after a crash each make a new one, so
 * what attempt 002 wrote is still there to read when the run finishes.
 *
 * The layout is fixed, and these names are part of the event format, so ADR
 * 0006's version covers them:
 *
 * ```text
 * runs/<runid>/attempts/<nnn>-<step>/
 *   stdout   stderr
 *   sock              the attempt socket (LOOPFILE_ENDPOINT, ADR 0005)
 *   scratch/          LOOPFILE_SCRATCH
 *   wiring/           harness wiring files (ADR 0004)
 *   data/<key>        values this attempt put (#18 owns what goes in)
 *   iterations/<nn>/  Ralph steps only: stdout, stderr, wiring/
 * ```
 *
 * `sock` is short on purpose. It is the longest path Loopfile builds, and a
 * Unix socket path has a hard length limit (ADR 0008), which is why
 * `createRunDirectory` checks the budget at launch against this shape.
 *
 * Inputs, prompts and the workspace are not copied in here. They belong to the
 * run, one level up.
 *
 * Nothing is made read-only. The run owner is the only process that writes
 * into an attempt folder, so read-only bits defend against nobody, and they
 * make deleting a run folder need a forced `rm -rf`. The test beside this file
 * is the guard instead.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptId } from "../domain/model.ts";
import { RunDirectoryError } from "./run-directory.ts";

/** The attempt socket's file name, the shape `createRunDirectory` budgets for. */
export const ATTEMPT_SOCKET_NAME = "sock";

/** Every path one attempt owns. */
export interface AttemptPaths {
  readonly root: string;
  /** Raw stdout of the attempt's process. */
  readonly stdout: string;
  /** Raw stderr. */
  readonly stderr: string;
  /** The attempt socket the step commands reach the run owner over (ADR 0005). */
  readonly socket: string;
  /** `LOOPFILE_SCRATCH`: writable during the attempt, collected by nobody. */
  readonly scratch: string;
  /** Harness wiring files (ADR 0004). */
  readonly wiring: string;
  /** One file per data key this attempt put. Shared by every Ralph iteration. */
  readonly data: string;
  /**
   * One folder per Ralph iteration, made by the first iteration. An agent step
   * and a command step have none, so a reader must expect it to be missing.
   */
  readonly iterations: string;
}

/** Raw output of one Ralph iteration. Written per call, never read back. */
export interface IterationPaths {
  readonly root: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly wiring: string;
}

/** Folders `createAttemptDirectory` makes inside the attempt folder. */
const ATTEMPT_SUBFOLDERS = ["scratch", "wiring", "data"] as const;

/** Where each of an attempt's files goes, given the run's `attempts` folder. */
export function attemptPaths(attemptsFolder: string, attemptId: AttemptId): AttemptPaths {
  const root = join(attemptsFolder, attemptId);
  return {
    root,
    stdout: join(root, "stdout"),
    stderr: join(root, "stderr"),
    socket: join(root, ATTEMPT_SOCKET_NAME),
    scratch: join(root, "scratch"),
    wiring: join(root, "wiring"),
    data: join(root, "data"),
    iterations: join(root, "iterations"),
  };
}

/**
 * Where one Ralph iteration's raw output goes. Iterations count from 1 and are
 * zero-padded to two digits, widening past 99 the way attempt numbers do.
 */
export function iterationPaths(attempt: AttemptPaths, iteration: number): IterationPaths {
  const root = join(attempt.iterations, String(iteration).padStart(2, "0"));
  return {
    root,
    stdout: join(root, "stdout"),
    stderr: join(root, "stderr"),
    wiring: join(root, "wiring"),
  };
}

/** Makes an attempt's folder and its fixed subfolders, or fails saying why. */
export async function createAttemptDirectory(
  attemptsFolder: string,
  attemptId: AttemptId,
): Promise<AttemptPaths> {
  const paths = attemptPaths(attemptsFolder, attemptId);
  await makeDirectory(attemptsFolder);
  await claimDirectory(paths.root);
  for (const name of ATTEMPT_SUBFOLDERS) await makeDirectory(join(paths.root, name));
  return paths;
}

/** Makes one Ralph iteration's folder and its `wiring/`. Also never reused. */
export async function createIterationDirectory(
  attempt: AttemptPaths,
  iteration: number,
): Promise<IterationPaths> {
  const paths = iterationPaths(attempt, iteration);
  await makeDirectory(attempt.iterations);
  await claimDirectory(paths.root);
  await makeDirectory(paths.wiring);
  return paths;
}

/**
 * Takes the folder for one attempt or one iteration: makes it, or takes over
 * one that nothing has been written into yet.
 *
 * A folder holding anything belongs to an earlier attempt and is never reused,
 * because writing into it would overwrite output the run is meant to keep.
 *
 * An empty one is a different thing. The folder is made *before*
 * `attempt.started` is appended, and the attempt number is counted from
 * `attempt.started` events, so a run owner that dies in that window — or whose
 * last log line a crash cut in half — leaves a folder no event mentions. The
 * resume computes the same number, and without this it would fail on its own
 * leftovers, every time, until somebody deleted them by hand.
 */
async function claimDirectory(path: string): Promise<void> {
  await mkdir(path).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || !(await isUnused(path))) throw directoryError(error, path);
  });
}

/** True when nothing has been written under `path`: empty folders and no more. */
async function isUnused(path: string): Promise<boolean> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return false;
  for (const entry of entries) {
    if (!entry.isDirectory()) return false;
    if (!(await isUnused(join(path, entry.name)))) return false;
  }
  return true;
}

/** Makes a folder that may already be there, such as `attempts/` or `scratch/`. */
async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    throw directoryError(error, path);
  });
}

/** Keeps the real reason, and names the path rather than guessing what it was for. */
function directoryError(error: NodeJS.ErrnoException, path: string): RunDirectoryError {
  const reason = error.code === "EEXIST" ? "already exists" : `cannot create (${error.code})`;
  return new RunDirectoryError(`${reason}: ${path}`, { cause: error });
}
