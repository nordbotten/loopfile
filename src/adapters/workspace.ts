/**
 * Creates the workspace selected for a run (#16, ADR 0014). `here` returns
 * the launch folder without running Git or creating a folder. `empty` creates
 * a new folder without reading the Target. `isolate` uses a worktree from
 * `HEAD` when possible, otherwise a full copy. Steps only see the workspace
 * path, as `LOOPFILE_WORKSPACE` and as their working directory (ADR 0005).
 *
 * A worktree does not carry uncommitted target changes; a full copy carries
 * them, including gitignored files. Successful runs remove only worktrees.
 */

import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { RunCreated } from "../domain/events.ts";
import type { WorkspaceMode } from "../domain/model.ts";

const run = promisify(execFile);

/** Thrown when a run's workspace cannot be located or created. */
export class WorkspaceError extends Error {}

/** A run's workspace, and the facts `run.created` records (ADR 0003). */
export type Workspace = WorktreeWorkspace | CopyWorkspace | HereWorkspace | EmptyWorkspace;

interface WorkspaceBase {
  readonly path: string;
}

interface TargetWorkspaceBase extends WorkspaceBase {
  readonly targetFolder: string;
}

export interface WorktreeWorkspace extends TargetWorkspaceBase {
  readonly mode?: "isolate";
  readonly isolateKind: "worktree";
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly branch: string;
}

export interface CopyWorkspace extends TargetWorkspaceBase {
  readonly mode?: "isolate";
  readonly isolateKind: "copy";
}

export interface HereWorkspace extends TargetWorkspaceBase {
  readonly mode: "here";
  readonly isolateKind?: undefined;
}

export interface EmptyWorkspace extends WorkspaceBase {
  readonly mode: "empty";
  readonly isolateKind?: undefined;
}

export function workspaceFromCreated(created: RunCreated, fallbackPath: string): Workspace {
  const targetFolder = created.targetFolder ?? fallbackPath;
  const path =
    created.workspacePath ?? (created.workspaceMode === "here" ? targetFolder : fallbackPath);
  if (created.workspaceMode === "here") {
    return { path, targetFolder, mode: "here" };
  }
  if (created.workspaceMode === "empty") return { path, mode: "empty" };
  if (created.isolateKind === "copy") {
    return { path, targetFolder, isolateKind: "copy" };
  }
  return {
    path,
    targetFolder,
    isolateKind: "worktree",
    repositoryPath: targetFolder,
    baseCommit: created.baseCommit ?? "",
    branch: created.branch ?? "",
  };
}

export interface CreateWorkspaceOptions {
  /** The launch folder used to resolve the Target folder; unused by `empty`. */
  readonly repository?: string;
  /** `RunPaths.workspace`, used by `isolate` and `empty`; ignored in `here`. */
  readonly path: string;
  readonly runId: string;
  readonly mode?: WorkspaceMode;
}

/** The Git top level containing `directory`, or the launch folder when Git cannot provide one. */
export async function targetRepository(directory: string): Promise<string> {
  const launchFolder = resolve(directory);
  try {
    return await git(launchFolder, "rev-parse", "--show-toplevel");
  } catch (error) {
    if (isGitMissing(error) || isNotGitRepository(error)) return launchFolder;
    throw new WorkspaceError(
      `cannot find the target folder ${launchFolder}: ${gitMessage(error)}`,
      {
        cause: error,
      },
    );
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
  if (options.mode === "empty") {
    await mkdir(options.path);
    return { path: options.path, mode: "empty" };
  }
  if (options.repository === undefined) {
    throw new WorkspaceError(
      `cannot make ${options.mode ?? "isolate"} workspace without a Target folder`,
    );
  }
  if (options.mode === "here") {
    const path = resolve(options.repository);
    return { path, targetFolder: path, mode: "here" };
  }
  const targetFolder = await targetRepository(options.repository);
  const baseCommit = await git(
    targetFolder,
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ).catch((error: unknown) => {
    if (isGitMissing(error) || isNotGitRepository(error) || errorCode(error) === 1)
      return undefined;
    throw new WorkspaceError(`cannot resolve HEAD in ${targetFolder}: ${gitMessage(error)}`, {
      cause: error,
    });
  });
  if (baseCommit === undefined) return await copyWorkspace(targetFolder, options.path);

  const commonDirectory = await git(
    targetFolder,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).catch((error: unknown) => {
    if (isGitMissing(error)) return undefined;
    throw new WorkspaceError(`cannot find Git's common directory: ${gitMessage(error)}`, {
      cause: error,
    });
  });
  if (commonDirectory === undefined) return await copyWorkspace(targetFolder, options.path);

  const repositoryPath = dirname(commonDirectory);
  const branch = `loopfile/${options.runId}`;
  try {
    await git(repositoryPath, "worktree", "add", "--quiet", "-b", branch, options.path, baseCommit);
  } catch (error) {
    if (isGitMissing(error)) return await copyWorkspace(targetFolder, options.path);
    throw new WorkspaceError(`cannot create the workspace ${options.path}: ${gitMessage(error)}`, {
      cause: error,
    });
  }
  return {
    path: options.path,
    targetFolder,
    isolateKind: "worktree",
    repositoryPath,
    baseCommit,
    branch,
  };
}

/** What removing a workspace did. A kept one says where it is and why. */
export type WorkspaceRemoval =
  | { readonly removed: true }
  | {
      readonly removed: false;
      readonly path: string;
      readonly reason: string;
      readonly dirty: boolean;
    };

/**
 * Removes the worktree with `git worktree remove`, with `--force` only when asked.
 *
 * Git refuses to remove a worktree with uncommitted work, and that refusal is
 * the guard: the workspace is kept and the reason is returned, not thrown.
 * `force` skips the guard and deletes that work. The run branch is never
 * touched, so committed work survives.
 */
export async function removeWorkspace(
  workspace: WorktreeWorkspace,
  force = false,
): Promise<WorkspaceRemoval> {
  const flags = force ? ["--force"] : [];
  try {
    await git(workspace.repositoryPath, "worktree", "remove", ...flags, workspace.path);
    return { removed: true };
  } catch (error) {
    if (isGitMissing(error) || isNotGitRepository(error)) {
      await rm(workspace.path, { recursive: true, force: true });
      return { removed: true };
    }
    return {
      removed: false,
      path: workspace.path,
      reason: gitMessage(error),
      dirty: isDirtyWorktreeRefusal(error),
    };
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

async function copyWorkspace(targetFolder: string, path: string): Promise<CopyWorkspace> {
  await cp(targetFolder, path, { recursive: true, force: false, errorOnExist: true }).catch(
    (error: unknown) => {
      throw new WorkspaceError(
        `cannot copy the target folder to ${path}: ${(error as Error).message}`,
        {
          cause: error,
        },
      );
    },
  );
  return { path, targetFolder, isolateKind: "copy" };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

function isGitMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT" && (error as { path?: unknown }).path === "git";
}

function isNotGitRepository(error: unknown): boolean {
  return /not a git repository/i.test(gitMessage(error));
}

function isDirtyWorktreeRefusal(error: unknown): boolean {
  return /contains modified or untracked files/i.test((error as { stderr?: string }).stderr ?? "");
}

/** Git's own reason, from its stderr, without the `fatal:` noise around it. */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr ? stderr.replace(/^fatal: /, "") : String(error);
}
