/**
 * The workspace: the one Git worktree a run's steps all work in (#16).
 *
 * A plain module, not an interface (ADR 0004). The rules are fixed by #87:
 * spawn `git` directly (ADR 0001), work on the main repository, start from
 * the launch directory's `HEAD`, and put the worktree at
 * `runs/<runid>/workspace` on the run branch `loopfile/<runid>`. Steps only see
 * the path, as `LOOPFILE_WORKSPACE` and as their working directory (ADR 0005).
 *
 * A dirty target repository is not refused and its changes are not carried
 * across: a new worktree never sees them. Launch prints one warning with the
 * count and goes on.
 *
 * The run owner creates the workspace and removes it when the run ends
 * successfully (#117). A failed, cancelled or crashed run keeps it.
 */

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Thrown when Git cannot give a run its workspace. The message says why. */
export class WorkspaceError extends Error {}

/** A run's workspace, and the three values `run.created` records (ADR 0003). */
export interface Workspace {
  /** The worktree's full path. Git's own record name for it is never used. */
  readonly path: string;
  readonly repositoryPath: string;
  /** The SHA `HEAD` resolved to. `HEAD` moves; this does not. */
  readonly baseCommit: string;
  /** `loopfile/<runid>`. Loopfile never deletes it. */
  readonly branch: string;
}

export interface CreateWorkspaceOptions {
  /** The folder launch ran in; its HEAD is the workspace base. */
  readonly repository: string;
  /** Where the worktree goes, `RunPaths.workspace`. Must not exist yet. */
  readonly path: string;
  readonly runId: string;
}

/** The top of the Git repository containing `directory`, or a launch error. */
export async function targetRepository(directory: string): Promise<string> {
  try {
    return await git(directory, "rev-parse", "--show-toplevel");
  } catch (error) {
    throw new WorkspaceError(`not inside a Git repository: ${directory} (${gitMessage(error)})`, {
      cause: error,
    });
  }
}

/**
 * Makes the run's worktree on a new run branch from the target's `HEAD`.
 *
 * The branch starts at the resolved SHA, not at `HEAD`, so the commit recorded
 * in `run.created` is the one the worktree has even if `HEAD` moves between
 * the two calls.
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<Workspace> {
  const { repository, path, runId } = options;
  const baseCommit = await git(
    repository,
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ).catch((error: unknown) => {
    // `--quiet` makes a missing `HEAD` a silent exit 1. Any other failure keeps git's reason.
    const message =
      (error as { code?: unknown }).code === 1
        ? `the target repository has no commits: ${repository}`
        : `cannot resolve HEAD in ${repository}: ${gitMessage(error)}`;
    throw new WorkspaceError(message, { cause: error });
  });
  const repositoryPath = dirname(
    await git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const branch = `loopfile/${runId}`;
  await git(repositoryPath, "worktree", "add", "--quiet", "-b", branch, path, baseCommit).catch(
    (error: unknown) => {
      throw new WorkspaceError(`cannot create the workspace ${path}: ${gitMessage(error)}`, {
        cause: error,
      });
    },
  );
  return { path, repositoryPath, baseCommit, branch };
}

/** What removing a workspace did. A kept one says where it is and why. */
export type WorkspaceRemoval =
  | { readonly removed: true }
  | { readonly removed: false; readonly path: string; readonly reason: string };

/**
 * Removes the worktree with `git worktree remove`, never with `--force`.
 *
 * Git refuses to remove a worktree with uncommitted work, and that refusal is
 * the guard: the workspace is kept and the reason is returned, not thrown.
 * The run branch is never touched, so committed work survives.
 */
export async function removeWorkspace(workspace: Workspace): Promise<WorkspaceRemoval> {
  try {
    await git(workspace.repositoryPath, "worktree", "remove", workspace.path);
    return { removed: true };
  } catch (error) {
    return { removed: false, path: workspace.path, reason: gitMessage(error) };
  }
}

/** Removes stale worktree records after a workspace folder disappeared. */
export async function pruneWorktrees(repository: string): Promise<void> {
  await git(repository, "worktree", "prune");
}

/** The one line the run's end message says about a workspace that stayed. */
export function keptWorkspaceMessage(kept: { path: string; reason: string }): string {
  return `workspace kept at ${kept.path}: ${kept.reason}`;
}

/** How many files `git status` lists as changed or untracked in the target repository. */
export async function uncommittedFiles(repository: string): Promise<number> {
  const status = await git(repository, "status", "--porcelain", "--untracked-files=all");
  return status === "" ? 0 : status.split("\n").length;
}

/** The one stderr line launch prints for a dirty target repository, or nothing for a clean one. */
export function dirtyRepositoryWarning(count: number): string | undefined {
  if (count === 0) return undefined;
  const files = count === 1 ? "file" : "files";
  const them = count === 1 ? "it" : "them";
  return `warning: the target repository has ${count} uncommitted ${files}. The workspace starts from HEAD without ${them}.`;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

/** Git's own reason, from its stderr, without the `fatal:` noise around it. */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr ? stderr.replace(/^fatal: /, "") : String(error);
}
