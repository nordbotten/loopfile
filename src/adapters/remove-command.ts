/** `loopfile remove <runid> [--kill-leftovers] [--force]`: discard one run, but keep its branch. */

import { readFile, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type OperatorErrorCode,
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { CorruptEventLogError, parseEventLog } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import { groupAlive } from "./local-executor.ts";
import { loopfileHome, pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";
import {
  pruneWorktrees,
  removeWorkspace,
  type Workspace,
  workspaceFromCreated,
} from "./workspace.ts";

const USAGE = "Usage: loopfile remove <runid> [--kill-leftovers] [--force]";
const HELP = `${USAGE}

Remove a run's workspace and folder, keeping its branch when it has one. A live
run must be cancelled first. --kill-leftovers kills processes left by the run
before removing it. --force also deletes uncommitted work in a worktree. Exit 0
means removal succeeded; invalid or refused work returns 2 (or 1 for a removal
operation failure).
`;

export interface RemoveOptions {
  readonly pingTimeoutMs?: number;
}

interface RemoveArgs {
  readonly runId?: string;
  readonly killLeftovers: boolean;
  readonly force: boolean;
  readonly help: boolean;
}

export type RemoveResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly branch?: string;
      readonly warning?: string;
    }
  | { readonly ok: false; readonly failure: RemoveFailure };

export interface RemoveFailure {
  readonly summary: string;
  readonly code: OperatorErrorCode;
  readonly help: string;
  readonly exitCode: 1 | 2;
}

/** Runs `argv`, which starts with `remove`. Returns the exit code. */
export async function removeCommand(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  env: Record<string, string | undefined>,
  options: RemoveOptions = {},
): Promise<number> {
  const args = parseRemoveArgs(argv);
  if (args === undefined) {
    err(renderFailure(failure("remove takes one run ID", "bad_argument", USAGE)));
    return 2;
  }
  if (args.help) {
    out(HELP);
    return 0;
  }
  if (args.runId === undefined) {
    err(renderFailure(failure("remove takes one run ID", "bad_argument", USAGE)));
    return 2;
  }

  const result = await removeRunWithArgs(
    loopfileHome(env as NodeJS.ProcessEnv),
    { ...args, runId: args.runId },
    options,
  );
  if (!result.ok) {
    err(renderFailure(result.failure));
    return result.failure.exitCode;
  }
  if (result.warning !== undefined) err(result.warning);
  err(
    renderOperatorConfirmation({
      removed: result.runId,
      ...(result.branch === undefined ? {} : { branch: `${result.branch} (kept)` }),
    }),
  );
  return 0;
}

function parseRemoveArgs(argv: readonly string[]): RemoveArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        help: { type: "boolean", short: "h" },
        "kill-leftovers": { type: "boolean" },
        force: { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (positionals.length > 1) return undefined;
    return {
      ...(positionals[0] === undefined ? {} : { runId: positionals[0] }),
      killLeftovers: values["kill-leftovers"] === true,
      force: values.force === true,
      help: values.help === true,
    };
  } catch {
    return undefined;
  }
}

/** Removes one run without killing any leftover processes. Shared by `prune`. */
export async function removeRun(
  home: string,
  runId: string,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
  return await removeRunWithArgs(
    home,
    { runId, killLeftovers: false, force: false, help: false },
    options,
  );
}

async function removeRunWithArgs(
  home: string,
  args: RemoveArgs & { readonly runId: string },
  options: RemoveOptions,
): Promise<RemoveResult> {
  const paths = runPaths(home, args.runId);
  const checked = await checkRun(paths, args.runId, options);
  if (!checked.ok) return checked;

  const leftover = leftoverProcessGroup(checked.events);
  if (leftover === 0 || !groupAlive(leftover))
    return removeFiles(paths, checked.created, args.force);
  if (!args.killLeftovers) {
    return refused(
      `run ${args.runId} still has processes in process group ${leftover}`,
      "leftover_processes",
      `Stop them with \`kill -KILL -- -${leftover}\`, or run \`loopfile remove ${args.runId} --kill-leftovers\`.`,
    );
  }
  killGroup(leftover);
  return removeFiles(paths, checked.created, args.force);
}

type CheckedRun =
  | {
      readonly ok: true;
      readonly events: readonly RunEvent[];
      readonly created: Extract<RunEvent, { type: "run.created" }>;
    }
  | { readonly ok: false; readonly failure: RemoveFailure };

async function checkRun(
  paths: RunPaths,
  runId: string,
  options: RemoveOptions,
): Promise<CheckedRun> {
  if (!(await pathExists(paths.root)))
    return refused(`no run ${runId}`, "no_such_run", "Use `loopfile list` to find a valid run ID.");
  if ((await pingOwner(paths.socket, options.pingTimeoutMs)) === runId) {
    return refused(
      `a run owner is still running run ${runId}`,
      "owner_alive",
      `Use \`loopfile cancel ${runId}\` to stop it, or wait for it to finish.`,
    );
  }
  const events = await readEvents(paths, runId);
  if (!events.ok) return events;
  const created = events.events[0];
  return created?.type === "run.created"
    ? { ok: true, events: events.events, created }
    : refused(
        `run ${runId} has no run.created event`,
        "log_corrupt",
        "Inspect events.jsonl before retrying removal.",
      );
}

async function readEvents(
  paths: RunPaths,
  runId: string,
): Promise<
  | { readonly ok: true; readonly events: readonly RunEvent[] }
  | { readonly ok: false; readonly failure: RemoveFailure }
> {
  const text = await readFile(paths.events, "utf8").catch(() => undefined);
  if (text === undefined) {
    return refused(
      `events.jsonl for run ${runId} could not be opened`,
      "log_unreadable",
      "Check that events.jsonl exists and is readable.",
    );
  }
  try {
    return { ok: true, events: parseEventLog(text) };
  } catch (error) {
    return refused(
      error instanceof Error ? error.message : String(error),
      error instanceof CorruptEventLogError ? "log_corrupt" : "operation_failed",
      "Inspect events.jsonl before retrying removal.",
    );
  }
}

async function removeRunWorkspace(
  workspace: Workspace,
  created: Extract<RunEvent, { type: "run.created" }>,
  force: boolean,
): Promise<RemoveResult | undefined> {
  if (workspace.mode === "here") return undefined;
  if (workspace.isolateKind === "copy") {
    await rm(workspace.path, { recursive: true, force: true });
    return undefined;
  }
  if (!(await pathExists(workspace.path))) {
    await pruneWorktrees(created.targetFolder);
    return undefined;
  }
  const removed = await removeWorkspace(workspace, force);
  return removed.removed
    ? undefined
    : refused(
        `workspace of run ${created.runId} is dirty: ${removed.reason}`,
        "workspace_dirty",
        `Commit or discard the workspace changes, or run \`loopfile remove ${created.runId} --force\` to delete them.`,
        1,
      );
}

async function removeFiles(
  paths: RunPaths,
  created: Extract<RunEvent, { type: "run.created" }>,
  force: boolean,
): Promise<RemoveResult> {
  try {
    const workspace = workspaceFromCreated(created, paths.workspace);
    const branch = workspace.isolateKind === "worktree" ? workspace.branch : undefined;
    if (!(await pathExists(created.targetFolder))) {
      await rm(paths.root, { recursive: true, force: true });
      return {
        ok: true,
        runId: created.runId,
        ...(branch === undefined ? {} : { branch }),
        warning: `warning: target folder is gone: ${created.targetFolder}\n`,
      };
    }
    const workspaceFailure = await removeRunWorkspace(workspace, created, force);
    if (workspaceFailure !== undefined) return workspaceFailure;
    await rm(paths.root, { recursive: true, force: true });
    return {
      ok: true,
      runId: created.runId,
      ...(branch === undefined ? {} : { branch }),
    };
  } catch (error) {
    return refused(
      error instanceof Error ? error.message : String(error),
      "operation_failed",
      "Inspect the run and target repository, then try again.",
      1,
    );
  }
}

/** The process group of the open attempt, or its last Ralph iteration. */
function leftoverProcessGroup(events: readonly RunEvent[]): number {
  let group = 0;
  for (const event of events) {
    if (event.type === "attempt.started") group = event.processGroupId;
    else if (event.type === "iteration.started") group = event.processGroupId;
    else if (event.type === "attempt.ended" || event.type === "attempt.interrupted") group = 0;
  }
  return group;
}

function killGroup(group: number): void {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // The group can disappear after the liveness check.
  }
}

function failure(
  summary: string,
  code: OperatorErrorCode,
  help: string,
  exitCode: 1 | 2 = 2,
): RemoveFailure {
  return { summary, code, help, exitCode };
}

function refused(
  summary: string,
  code: OperatorErrorCode,
  help: string,
  exitCode: 1 | 2 = 2,
): { readonly ok: false; readonly failure: RemoveFailure } {
  return { ok: false, failure: failure(summary, code, help, exitCode) };
}

function renderFailure(failure: RemoveFailure): string {
  return renderOperatorFailure(failure, failure.exitCode).stderr;
}
