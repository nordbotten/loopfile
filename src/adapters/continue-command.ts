/** `loopfile continue <runid> [-d]`: continue an ended, non-completed run (#85). */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { continueRefusal } from "../application/continue.ts";
import { renderOperatorFailure } from "../application/operator-error.ts";
import {
  CorruptEventLogError,
  isCompleted,
  isInternalError,
  parseEventLog,
  replay,
} from "../application/replay.ts";
import { modelDigest } from "../application/workflow-run.ts";
import type { RunEvent } from "../domain/events.ts";
import { type LaunchIo, type LaunchOptions, startOwner } from "./launch-command.ts";
import { CONTINUE_ENV } from "./owner-command.ts";
import { loopfileHome, pathExists, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";
import { loadMaterialized } from "./workflow-run.ts";

const USAGE = "Usage: loopfile continue <runid> [-d | --detach]";
const HELP = `${USAGE}

Continue a run that ended without completing. It reuses the run's workspace and
Materialized Loopfile, and retries the stopped step with new run limits.
Without --detach, a terminal attaches the monitor; press d to detach. With no
terminal and without --detach, wait until the run ends.
`;

type ContinueIo = Pick<LaunchIo, "out" | "err" | "monitor">;

/** Overridable for tests only. */
export interface ContinueOptions extends LaunchOptions {
  readonly pingTimeoutMs?: number;
}

interface ContinueArgs {
  readonly runId?: string;
  readonly detach: boolean;
  readonly help: boolean;
}

interface Failure {
  readonly summary: string;
  readonly code:
    | "bad_argument"
    | "no_such_run"
    | "log_unreadable"
    | "log_corrupt"
    | "owner_alive"
    | "operation_failed"
    | "format_mismatch"
    | "workspace_missing";
  readonly help: string;
  readonly exitCode: 1 | 2;
}

/** Runs `argv`, which starts with `continue`. Returns the exit code. */
export async function continueCommand(
  argv: readonly string[],
  cli: string,
  io: ContinueIo,
  env: Record<string, string | undefined>,
  options: ContinueOptions = {},
): Promise<number> {
  const args = parseContinueArgs(argv);
  if (args === undefined) return refuse(io, USAGE, 2);
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  if (args.runId === undefined) return refuse(io, USAGE, 2);

  const paths = runPaths(loopfileHome(env as NodeJS.ProcessEnv), args.runId);
  const refusal = await checkContinue(paths, args.runId, options.pingTimeoutMs).catch(
    (error: Error): Failure => ({
      summary: error.message,
      code: "operation_failed",
      help: "Inspect the run and try again.",
      exitCode: 2,
    }),
  );
  if (refusal !== undefined) {
    io.err(renderOperatorFailure(refusal, refusal.exitCode).stderr);
    return refusal.exitCode;
  }

  return await startOwner(
    {
      runId: args.runId,
      paths,
      ownerEnv: { ...env, [CONTINUE_ENV]: "1" },
      detach: args.detach,
      cli,
      confirmation: "continued",
    },
    io,
    env,
    options,
  );
}

function parseContinueArgs(argv: readonly string[]): ContinueArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { detach: { type: "boolean", short: "d" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
    if (positionals.length > 1) return undefined;
    return {
      ...(positionals[0] === undefined ? {} : { runId: positionals[0] }),
      detach: values.detach === true,
      help: values.help === true,
    };
  } catch {
    return undefined;
  }
}

async function checkContinue(
  paths: ReturnType<typeof runPaths>,
  runId: string,
  pingTimeoutMs: number | undefined,
): Promise<Failure | undefined> {
  const events = await readRunEvents(paths, runId);
  if ("summary" in events) return events;
  if ((await pingOwner(paths.socket, pingTimeoutMs)) === runId) {
    return {
      summary: `a run owner is still running run ${runId}`,
      code: "owner_alive",
      help: `Use \`loopfile interrupt ${runId}\` to stop its current attempt, or wait for it to finish.`,
      exitCode: 2,
    };
  }
  const refusal = continueRefusal(events, modelDigest(await loadMaterialized(paths)));
  if (refusal !== undefined) return refusalFailure(refusal, events, runId);
  if (!(await pathExists(paths.workspace))) {
    return {
      summary: `the workspace of run ${runId} is gone`,
      code: "workspace_missing",
      help: `Workspace path: ${paths.workspace}. Continue never makes a new one.`,
      exitCode: 2,
    };
  }
  return undefined;
}

/** The run's parsed event log, or why it cannot be read. */
async function readRunEvents(
  paths: ReturnType<typeof runPaths>,
  runId: string,
): Promise<readonly RunEvent[] | Failure> {
  if (!(await pathExists(paths.root))) {
    return {
      summary: `no run ${runId}`,
      code: "no_such_run",
      help: "Use `loopfile list` to find a valid run ID.",
      exitCode: 2,
    };
  }
  const text = await readFile(paths.events, "utf8").catch(() => undefined);
  if (text === undefined) {
    return {
      summary: `events.jsonl for run ${runId} could not be opened`,
      code: "log_unreadable",
      help: "Check that events.jsonl exists and is readable.",
      exitCode: 2,
    };
  }
  try {
    return parseEventLog(text);
  } catch (error) {
    return {
      summary: error instanceof Error ? error.message : String(error),
      code: error instanceof CorruptEventLogError ? "log_corrupt" : "operation_failed",
      help: "Inspect events.jsonl before continuing the run.",
      exitCode: 2,
    };
  }
}

/** A `continueRefusal` as an operator failure, with help that names the command to use instead. */
function refusalFailure(refusal: string, events: readonly RunEvent[], runId: string): Failure {
  const formatMismatch = refusal.includes("format version") || refusal.includes("model digest");
  return {
    summary: refusal,
    code: formatMismatch ? "format_mismatch" : "operation_failed",
    help: refusalHelp(events, runId, formatMismatch),
    exitCode: formatMismatch ? 2 : 1,
  };
}

function refusalHelp(events: readonly RunEvent[], runId: string, formatMismatch: boolean): string {
  const { result } = replay(events);
  if (result === undefined || isInternalError(result)) {
    return `Use \`loopfile resume ${runId}\` for a crashed run or internal_error.`;
  }
  if (isCompleted(result)) {
    return "Start a new run; completed runs cannot be continued.";
  }
  const created = events[0];
  if (created?.type === "run.created" && created.loopId !== undefined) {
    return `Loop ${created.loopId} owns this child run; it cannot be continued on its own.`;
  }
  return formatMismatch
    ? "Continue requires the original event format and Materialized Loopfile model."
    : "Inspect the run before trying again.";
}

function refuse(io: ContinueIo, message: string, exitCode: 1 | 2): number {
  io.err(
    renderOperatorFailure({ summary: message, code: "bad_argument", help: USAGE }, exitCode).stderr,
  );
  return exitCode;
}
