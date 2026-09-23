/**
 * `loopfile resume [<runid>] [-d] [--kill-leftovers]`: go on with a crashed run (#64).
 *
 * Every check runs here, in the foreground, where a person reads the error
 * (ADR 0006, ADR 0008): a run owner that still answers, a corrupt event log, a
 * run that ended or was cancelled, a changed model, a missing workspace and
 * processes the interrupted attempt left behind. Then the run owner starts the
 * same way as for a new run. It writes `owner.started` and
 * `attempt.interrupted`; this command writes no run state.
 *
 * Bare `loopfile resume` lists the crashed runs and resumes none of them.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { renderOperatorFailure } from "../application/operator-error.ts";
import { CorruptEventLogError, parseEventLog, replay } from "../application/replay.ts";
import { resumePlan, resumeRefusal } from "../application/resume.ts";
import { renderRunList } from "../application/run-list.ts";
import { modelDigest } from "../application/workflow-run.ts";
import type { RunEvent } from "../domain/events.ts";
import { type LaunchIo, type LaunchOptions, startOwner } from "./launch-command.ts";
import { groupAlive } from "./local-executor.ts";
import { RESUME_ENV } from "./owner-command.ts";
import { loopfileHome, pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { discoverRuns } from "./run-discovery.ts";
import { pingOwner } from "./run-owner.ts";
import { loadMaterialized } from "./workflow-run.ts";

const USAGE = "Usage: loopfile resume <runid> [-d | --detach] [--kill-leftovers]";
const HELP = `Usage: loopfile resume [<runid>] [-d | --detach] [--kill-leftovers]

Resume a crashed run. With no run ID, list crashed runs without resuming one.
Without --detach, a terminal attaches the live monitor; press d to detach while
the run continues. With --detach, print the run ID and return. With no
terminal and without --detach, wait silently until the run ends.

Exit codes are 0 when the run completes or is detached, 1 when it fails or is
cancelled, and 2 when it cannot start or the run owner crashes.
`;

export type ResumeIo = Pick<LaunchIo, "out" | "err" | "monitor">;

/** Overridable for tests only. */
export interface ResumeOptions extends LaunchOptions {
  readonly pingTimeoutMs?: number;
}

interface ResumeArgs {
  readonly runId?: string;
  readonly detach: boolean;
  readonly killLeftovers: boolean;
  readonly help: boolean;
}

/** Runs `argv`, which starts with `resume`. Returns the exit code. */
export async function resumeCommand(
  argv: readonly string[],
  cli: string,
  io: ResumeIo,
  env: Record<string, string | undefined>,
  options: ResumeOptions = {},
): Promise<number> {
  const args = parseResumeArgs(argv);
  if (args === undefined) return refuse(io, USAGE, 2);
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  const { runId } = args;
  if (runId === undefined) return await listCrashed(io, env);

  const paths = runPaths(loopfileHome(env as NodeJS.ProcessEnv), runId);
  const refused = await checkResume(paths, runId, args.killLeftovers, options).catch(
    (error: Error): ResumeFailure => ({
      summary: error.message,
      code: "operation_failed",
      help: "Inspect the run and try again.",
      exitCode: 2,
    }),
  );
  if (refused !== undefined) {
    io.err(renderOperatorFailure(refused, refused.exitCode).stderr);
    return refused.exitCode;
  }

  const ownerEnv = { ...env, [RESUME_ENV]: "1" };
  return await startOwner(
    { runId, paths, ownerEnv, detach: args.detach, cli, confirmation: "resumed" },
    io,
    env,
    options,
  );
}

function parseResumeArgs(argv: readonly string[]): ResumeArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        detach: { type: "boolean", short: "d" },
        help: { type: "boolean", short: "h" },
        "kill-leftovers": { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (positionals.length > 1) return undefined;
    const [runId] = positionals;
    return {
      ...(runId === undefined ? {} : { runId }),
      detach: values.detach === true,
      killLeftovers: values["kill-leftovers"] === true,
      help: values.help === true,
    };
  } catch {
    return undefined;
  }
}

function refuse(io: ResumeIo, message: string, exitCode: 1 | 2): number {
  io.err(
    renderOperatorFailure({ summary: message, code: "bad_argument", help: USAGE }, exitCode).stderr,
  );
  return exitCode;
}

/** Prints the crashed runs, the only ones resume takes, and picks none. */
async function listCrashed(io: ResumeIo, env: Record<string, string | undefined>): Promise<number> {
  const crashed = (await discoverRuns(env as NodeJS.ProcessEnv)).filter(
    (entry) => entry.state === "crashed",
  );
  if (crashed.length === 0) {
    io.out("no crashed runs\n");
    return 0;
  }
  io.out(`${renderRunList(crashed, false)}Resume one with: loopfile resume <runid>\n`);
  return 0;
}

/**
 * Why the run may not be resumed, or nothing when it may. With
 * `killLeftovers`, the interrupted attempt's leftover processes are killed
 * instead of stopping the resume.
 */
interface ResumeFailure {
  readonly summary: string;
  readonly code:
    | "no_such_run"
    | "log_unreadable"
    | "log_corrupt"
    | "owner_alive"
    | "workspace_missing"
    | "format_mismatch"
    | "operation_failed";
  readonly help: string;
  readonly exitCode: 1 | 2;
}

async function checkResume(
  paths: RunPaths,
  runId: string,
  killLeftovers: boolean,
  options: ResumeOptions,
): Promise<ResumeFailure | undefined> {
  const log = await readResumeLog(paths, runId);
  if (typeof log !== "string") return log;
  const ownerFailure = await liveOwnerFailure(paths, runId, options);
  if (ownerFailure !== undefined) return ownerFailure;
  const parsed = parseResumeLog(log);
  if ("summary" in parsed) return parsed;
  const workflow = await loadMaterialized(paths);
  const mismatch = resumeMismatch(parsed, modelDigest(workflow));
  if (mismatch !== undefined) return mismatch;
  if (!(await pathExists(paths.workspace))) return workspaceFailure(paths, runId);
  const { interrupted, leftoverGroup = 0 } = resumePlan(workflow, parsed);
  return leftoverFailure(interrupted, leftoverGroup, runId, killLeftovers);
}

async function readResumeLog(paths: RunPaths, runId: string): Promise<string | ResumeFailure> {
  if (!(await pathExists(paths.root))) {
    return {
      summary: `no run ${runId}`,
      code: "no_such_run",
      help: "Use `loopfile list` to find a valid run ID.",
      exitCode: 2,
    };
  }
  const text = await readFile(paths.events, "utf8").catch(() => undefined);
  return (
    text ?? {
      summary: `no run ${runId}: ${paths.events} cannot be read`,
      code: "log_unreadable",
      help: "Inspect the run folder or remove the unreadable run.",
      exitCode: 2,
    }
  );
}

async function liveOwnerFailure(
  paths: RunPaths,
  runId: string,
  options: ResumeOptions,
): Promise<ResumeFailure | undefined> {
  if ((await pingOwner(paths.socket, options.pingTimeoutMs)) !== runId) return undefined;
  return {
    summary: `a run owner is still running run ${runId}`,
    code: "owner_alive",
    help: `Use \`loopfile interrupt ${runId}\` to stop its current attempt, or wait for it to finish.`,
    exitCode: 2,
  };
}

function parseResumeLog(text: string): readonly RunEvent[] | ResumeFailure {
  try {
    return parseEventLog(text);
  } catch (error) {
    return {
      summary: error instanceof Error ? error.message : String(error),
      code: error instanceof CorruptEventLogError ? "log_corrupt" : "operation_failed",
      help: "The run event log must be repaired or removed before it can be resumed.",
      exitCode: 2,
    };
  }
}

function resumeMismatch(events: readonly RunEvent[], digest: string): ResumeFailure | undefined {
  const refused = resumeRefusal(events, digest);
  if (refused === undefined) return undefined;
  if (refused.includes("event format") || refused.includes("Materialized Loopfile")) {
    return {
      summary: refused,
      code: "format_mismatch",
      help: "Resume requires the original event format and model.",
      exitCode: 2,
    };
  }
  const state = replay(events);
  const help =
    state.result?.result === "success" && state.result.reason === "end_state"
      ? "Completed runs cannot be continued; start a new run instead."
      : state.result?.result !== "cancelled" && state.result?.reason === "internal_error"
        ? `Use \`loopfile resume ${state.runId}\` for this internal_error.`
        : `Use \`loopfile continue ${state.runId}\` to continue this ended run.`;
  return { summary: refused, code: "operation_failed", help, exitCode: 1 };
}

function workspaceFailure(paths: RunPaths, runId: string): ResumeFailure {
  return {
    summary: `the workspace of run ${runId} is gone`,
    code: "workspace_missing",
    help: `Workspace path: ${paths.workspace}. Resume never makes a new one.`,
    exitCode: 2,
  };
}

function leftoverFailure(
  interrupted: Extract<RunEvent, { type: "attempt.started" }> | undefined,
  group: number,
  runId: string,
  killLeftovers: boolean,
): ResumeFailure | undefined {
  const leftover = leftovers(interrupted, group, runId, killLeftovers);
  return leftover === undefined
    ? undefined
    : {
        summary: leftover,
        code: "operation_failed",
        help: "Stop the leftover process group, then retry resume.",
        exitCode: 2,
      };
}

/** Refuses when the interrupted attempt's leftover group still has processes, unless they are to be killed. */
function leftovers(
  interrupted: Extract<RunEvent, { type: "attempt.started" }> | undefined,
  group: number,
  runId: string,
  killLeftovers: boolean,
): string | undefined {
  // 0 is no group: a process that never started, or a Ralph attempt with no iteration yet.
  if (group === 0 || !groupAlive(group)) return undefined;
  if (killLeftovers) {
    signalGroup(group);
    return undefined;
  }
  return (
    `attempt ${interrupted?.attemptId} still has processes in process group ${group}. ` +
    `Stop them with \`kill -KILL -- -${group}\`, or run \`loopfile resume ${runId} --kill-leftovers\`.`
  );
}

function signalGroup(group: number): void {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Gone since the check: nothing is left to kill.
  }
}
