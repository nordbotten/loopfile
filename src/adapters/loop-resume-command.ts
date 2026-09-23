/** `loopfile resume <loopid> [-d] [--kill-leftovers]`: resume a crashed loop. */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type OperatorErrorCode,
  type OperatorFailure,
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { CorruptEventLogError, parseEventLog } from "../application/replay.ts";
import type { LoopEvent } from "../domain/events.ts";
import type { LaunchIo } from "./launch-command.ts";
import { startDetachedOwner } from "./launch-command.ts";
import { attachLoop, type LoopCommandOptions } from "./loop-command.ts";
import { type LoopPaths, loopfileHome, loopPaths, pathExists } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

const USAGE = "Usage: loopfile resume <loopid> [-d | --detach] [--kill-leftovers]";
const HELP = `${USAGE}

Resume a crashed loop. Without --detach, report each run and the loop's end.
With --detach, print the loop ID and return after the owner is ready.
`;

export interface LoopResumeOptions extends LoopCommandOptions {
  readonly pingTimeoutMs?: number;
}

interface LoopResumeArgs {
  readonly loopId?: string;
  readonly detach: boolean;
  readonly help: boolean;
}

type LoopResumeCheck =
  | { readonly ok: true; readonly home: string; readonly paths: LoopPaths }
  | { readonly ok: false; readonly failure: OperatorFailure };

/** Resumes a crashed loop using its original event log and settings. */
export async function loopResumeCommand(
  argv: readonly string[],
  cli: string,
  io: Pick<LaunchIo, "out" | "err" | "monitor">,
  env: Record<string, string | undefined>,
  options: LoopResumeOptions = {},
): Promise<number> {
  const args = parseArgsForLoopResume(argv);
  if (args === undefined)
    return refuse(io, "could not parse loop resume arguments", "bad_argument");
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  if (args.loopId === undefined) return refuse(io, USAGE, "bad_argument");

  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const check = await checkLoopResume(home, args.loopId, options.pingTimeoutMs);
  if (!check.ok) {
    io.err(renderOperatorFailure(check.failure).stderr);
    return 2;
  }

  const started = await startDetachedOwner({
    ownerId: args.loopId,
    paths: check.paths,
    ownerEnv: env,
    cli,
    ownerCommand: "__loop-owner",
    ownerKind: "loop",
    readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
  });
  if (!started.ok) {
    io.err(
      renderOperatorFailure(
        {
          summary: started.failure.messages.join("; "),
          code: started.failure.code,
          help: started.failure.help,
        },
        started.failure.exitCode,
      ).stderr,
    );
    return started.failure.exitCode;
  }

  io.out(`${args.loopId}\n`);
  io.err(renderOperatorConfirmation({ resumed: args.loopId }));
  return args.detach ? 0 : await attachLoop(args.loopId, check.home, io.err, options);
}

async function checkLoopResume(
  home: string,
  loopId: string,
  pingTimeoutMs: number | undefined,
): Promise<LoopResumeCheck> {
  const paths = loopPaths(home, loopId);
  try {
    if (!(await pathExists(paths.root))) {
      return failure(
        `no loop ${loopId}`,
        "no_such_loop",
        "Use `loopfile list` to find a valid loop ID.",
      );
    }
    const invalid = await checkLoopEvents(paths, loopId, pingTimeoutMs);
    if (invalid !== undefined) return { ok: false, failure: invalid };
  } catch (error) {
    return failure(
      `could not read loop ${loopId}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof CorruptEventLogError ? "log_corrupt" : "log_unreadable",
      "Check the loop folder and events.jsonl before retrying the resume.",
    );
  }
  return { ok: true, home, paths };
}

async function checkLoopEvents(
  paths: LoopPaths,
  loopId: string,
  pingTimeoutMs: number | undefined,
): Promise<OperatorFailure | undefined> {
  const history = await readLoopHistory(paths, loopId);
  if ("failure" in history) return history.failure;
  const created = history.events[0];
  if (created?.type !== "loop.created" || created.loopId !== loopId) {
    return {
      summary: `events.jsonl for loop ${loopId} does not start with its loop.created event`,
      code: "log_corrupt",
      help: "Inspect events.jsonl before retrying the resume.",
    };
  }
  if ((await pingOwner(paths.socket, pingTimeoutMs)) === loopId) {
    return {
      summary: `a loop owner is still running loop ${loopId}`,
      code: "owner_alive",
      help: "Wait for it to finish, or resume after its owner has stopped.",
    };
  }
  const ended = history.events.findLast((event) => event.type === "loop.ended");
  return ended?.type === "loop.ended"
    ? {
        summary: `loop ${loopId} already ended: ${ended.reason}`,
        code: "already_ended",
        help: "Resume is only for a crashed loop: start a new loop instead.",
      }
    : undefined;
}

async function readLoopHistory(
  paths: LoopPaths,
  loopId: string,
): Promise<{ readonly events: readonly LoopEvent[] } | { readonly failure: OperatorFailure }> {
  try {
    return { events: parseEventLog<LoopEvent>(await readFile(paths.events, "utf8")) };
  } catch (error) {
    return {
      failure: {
        summary: `could not read loop ${loopId}: ${error instanceof Error ? error.message : String(error)}`,
        code: error instanceof CorruptEventLogError ? "log_corrupt" : "log_unreadable",
        help: "Check the loop folder and events.jsonl before retrying the resume.",
      },
    };
  }
}

function parseArgsForLoopResume(argv: readonly string[]): LoopResumeArgs | undefined {
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
    return {
      ...(positionals[0] === undefined ? {} : { loopId: positionals[0] }),
      detach: values.detach === true,
      help: values.help === true,
    };
  } catch {
    return undefined;
  }
}

function failure(summary: string, code: OperatorErrorCode, help: string): LoopResumeCheck {
  return { ok: false, failure: { summary, code, help } };
}

function refuse(
  io: Pick<LaunchIo, "err">,
  summary: string,
  code: OperatorErrorCode,
  help = USAGE,
): number {
  io.err(renderOperatorFailure({ summary, code, help }, 2).stderr);
  return 2;
}
