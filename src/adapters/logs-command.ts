/**
 * `loopfile logs <runid> [<attempt>]`: prints one attempt's raw stdout and
 * stderr (#37, decided in #91).
 *
 * A read-only view of the attempt folder (#15). It never reads `status.json`
 * or `activity.log` (ADR 0007) and never writes a run file, so it works after
 * `status.json` is deleted and while the run owner is gone. Attempt IDs come
 * from the attempt folders on disk, not from replaying `events.jsonl`.
 *
 * Everything a human reads — the attempt folder path, stream headers,
 * iteration headers, and every `error:` line — goes to stderr. `stdout`
 * carries file bytes only, so the default mode pipes cleanly.
 */

import { readdir, readFile } from "node:fs/promises";
import {
  isAttemptFolderName,
  iterationHeader,
  iterationOnNonRalphMessage,
  parseLogsArgs,
  selectAttempt,
  selectIteration,
  sortAttempts,
  streamHeader,
  unknownAttemptMessage,
  unknownIterationMessage,
  unknownRunMessage,
} from "../application/logs.ts";
import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { type AttemptPaths, attemptPaths, iterationPaths } from "./attempt-directory.ts";
import { loopfileHome, pathExists, type RunPaths, runPaths } from "./run-directory.ts";

type Out = (bytes: string | Uint8Array) => void;
type Err = (text: string) => void;

const HELP = `Usage: loopfile logs <runid> [<attempt>] [--stdout | --stderr] [--iteration <n>]
       loopfile logs <runid> --owner

Print an attempt's raw stdout and stderr, or the run owner's raw log. Without
a stream flag, headers and reports go to stderr while raw bytes go to stdout;
--stdout or --stderr prints only that stream. --iteration selects one Ralph
iteration. Logs describes a run and returns 0 when readable, or 2 for an
invalid or unreadable call.
`;

/** Runs `logs`. Returns the process exit code. */
export async function logsCommand(
  argv: readonly string[],
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const args = parseLogsArgs(argv);
  if (!args.ok) {
    return fail(err, {
      summary: args.message,
      code: "bad_argument",
      help: "Use `loopfile logs <runid>` with a readable run ID.",
    });
  }

  try {
    return await runLogs(args, out, err, env);
  } catch (error) {
    // Anything past this point is a filesystem surprise `logs` has no
    // specific answer for — a permission error, say — not one of the three
    // outcomes #91 names. It still gets one `error:` line, never a stack
    // trace on someone's terminal.
    return fail(err, failureFrom(error));
  }
}

type LogsArgs = Extract<ReturnType<typeof parseLogsArgs>, { ok: true }>;

/** The attempt `logs` settled on: its ID, its paths, and its Ralph iterations, if any. */
interface ResolvedAttempt {
  readonly attemptId: string;
  readonly paths: AttemptPaths;
  readonly iterations: readonly number[] | undefined;
}

async function runLogs(
  args: LogsArgs,
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
): Promise<number> {
  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const paths = runPaths(home, args.runId);

  if (args.owner) return await printOwnerLog(paths, args.runId, out, err);

  const resolved = await resolveAttempt(paths, args);
  if ("code" in resolved) return fail(err, resolved);

  err(`${resolved.paths.root}\n`);
  return await printAttempt(resolved, args, out, err);
}

/**
 * Finds the run and the attempt `args` asks for, or reports why it could not
 * and returns the exit code to give back straight away.
 */
async function printOwnerLog(paths: RunPaths, runId: string, out: Out, err: Err): Promise<number> {
  if (!(await pathExists(paths.root))) {
    return fail(err, {
      summary: unknownRunMessage(runId),
      code: "no_such_run",
      help: "Use `loopfile list` to find a valid run ID.",
    });
  }
  out(await readFile(paths.ownerLog));
  return 0;
}

async function resolveAttempt(
  paths: RunPaths,
  args: LogsArgs,
): Promise<ResolvedAttempt | OperatorFailure> {
  if (!(await pathExists(paths.root))) {
    return {
      summary: unknownRunMessage(args.runId),
      code: "no_such_run",
      help: "Use `loopfile list` to find a valid run ID.",
    };
  }

  const attemptNames = (await listDirectories(paths.attempts)).filter(isAttemptFolderName);
  const attemptId = selectAttempt(attemptNames, args.attempt);
  if (attemptId === undefined) {
    return {
      summary: unknownAttemptMessage(args.runId, sortAttempts(attemptNames)),
      code: "bad_argument",
      help: "Use `loopfile logs <runid>` or name one of the listed attempts.",
    };
  }

  const attemptPathsValue = attemptPaths(paths.attempts, attemptId);
  return {
    attemptId,
    paths: attemptPathsValue,
    iterations: await listIterationNumbers(attemptPathsValue),
  };
}

/** Prints `attempt`'s output as `args` asks: one non-Ralph attempt, all iterations, or one of them. */
async function printAttempt(
  attempt: ResolvedAttempt,
  args: LogsArgs,
  out: Out,
  err: Err,
): Promise<number> {
  const { attemptId, paths, iterations } = attempt;

  if (iterations === undefined) {
    if (args.iteration !== undefined) {
      return fail(err, {
        summary: iterationOnNonRalphMessage(attemptId),
        code: "bad_argument",
        help: "Omit --iteration for a non-Ralph attempt.",
      });
    }
    await printStreams(paths.stdout, paths.stderr, args.stream, out, err);
    return 0;
  }

  if (args.iteration === undefined) {
    for (const iteration of iterations)
      await printIteration(paths, iteration, args.stream, out, err);
    return 0;
  }

  const iteration = selectIteration(iterations, args.iteration);
  if (iteration === undefined) {
    return fail(err, {
      summary: unknownIterationMessage(attemptId, iterations),
      code: "bad_argument",
      help: "Use one of the iterations listed in the error.",
    });
  }
  await printIteration(paths, iteration, args.stream, out, err);
  return 0;
}

async function printIteration(
  attempt: AttemptPaths,
  iteration: number,
  stream: "stdout" | "stderr" | undefined,
  out: Out,
  err: Err,
): Promise<void> {
  err(iterationHeader(iteration));
  const paths = iterationPaths(attempt, iteration);
  await printStreams(paths.stdout, paths.stderr, stream, out, err);
}

/**
 * Writes one or both streams. A single stream (`--stdout`/`--stderr`) prints
 * with no header; the default prints stderr first, then stdout, each behind
 * one. Either way only file bytes reach `out`.
 */
async function printStreams(
  stdoutPath: string,
  stderrPath: string,
  stream: "stdout" | "stderr" | undefined,
  out: Out,
  err: Err,
): Promise<void> {
  if (stream === "stdout") {
    const bytes = await readOrEmpty(stdoutPath);
    return out(bytes);
  }
  if (stream === "stderr") {
    const bytes = await readOrEmpty(stderrPath);
    return out(bytes);
  }

  const stderr = await readOrEmpty(stderrPath);
  const stdout = await readOrEmpty(stdoutPath);
  err(streamHeader("stderr"));
  out(stderr);
  err(streamHeader("stdout"));
  out(stdout);
}

/** A missing output file is a fact about the attempt, not a failure (#91). */
async function readOrEmpty(path: string): Promise<Uint8Array> {
  return await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return new Uint8Array(0);
    throw error;
  });
}

/** Every Ralph iteration number in order, or nothing when the attempt has none. */
async function listIterationNumbers(attempt: AttemptPaths): Promise<readonly number[] | undefined> {
  const entries = await readdir(attempt.iterations, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    },
  );
  if (entries === undefined) return undefined;
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
}

async function listDirectories(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function failureFrom(error: unknown): OperatorFailure {
  return {
    summary: error instanceof Error ? error.message : String(error),
    code: "log_unreadable",
    help: "Check that the run and attempt output files are readable.",
  };
}

function fail(err: Err, failure: OperatorFailure): 2 {
  err(renderOperatorFailure(failure).stderr);
  return 2;
}
