import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ExecutionContext } from "../application/executor.ts";
import type { CommandStep } from "../domain/model.ts";
import { attemptPaths, createAttemptDirectory } from "./attempt-directory.ts";
import { startCommandStep } from "./command-step.ts";
import { localExecutor } from "./local-executor.ts";
import {
  createWorkspace,
  dirtyRepositoryWarning,
  targetRepository,
  uncommittedFiles,
  WorkspaceError,
} from "./workspace.ts";

const run = promisify(execFile);

/** A test identity, so commits work on a machine with no global Git config. */
const gitEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env: gitEnv })).stdout.trim();
}

/** Every folder the tests make, removed once they all end. */
const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "loopfile-ws-")));
  folders.push(path);
  return path;
}

/** A target repository with one commit, and a run folder outside it. */
async function repository(): Promise<{ repo: string; runRoot: string }> {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "first");
  const runRoot = join(root, "runs", "20260918-120000-abcd");
  await mkdir(runRoot, { recursive: true });
  return { repo, runRoot };
}

test("the target repository is the one containing the directory", async () => {
  const { repo } = await repository();
  await mkdir(join(repo, "src"));
  assert.equal(await targetRepository(join(repo, "src")), repo);
});

test("here uses the launch folder without creating a workspace", async () => {
  const { repo, runRoot } = await repository();
  const workspace = await createWorkspace({
    repository: repo,
    path: join(runRoot, "workspace"),
    runId: "r-here",
    mode: "here",
  });

  assert.deepEqual(workspace, { path: repo, targetFolder: repo, mode: "here" });
  await assert.rejects(stat(join(runRoot, "workspace")), { code: "ENOENT" });
});

test("outside Git, the target is the launch folder and isolate makes a full copy", async () => {
  const root = await scratch();
  const dir = join(root, "target");
  const path = join(root, "workspace");
  await mkdir(dir);
  await writeFile(join(dir, "visible.txt"), "visible\n");
  await mkdir(join(dir, ".claude"));
  await writeFile(join(dir, ".claude", "settings.local.json"), "ignored\n");

  assert.equal(await targetRepository(dir), dir);
  assert.deepEqual(await createWorkspace({ repository: dir, path, runId: "r1" }), {
    path,
    targetFolder: dir,
    isolateKind: "copy",
  });
  assert.equal(await readFile(join(path, "visible.txt"), "utf8"), "visible\n");
  assert.equal(await readFile(join(path, ".claude", "settings.local.json"), "utf8"), "ignored\n");
});

test("the workspace is a worktree on loopfile/<runid> from HEAD, at the given path", async () => {
  const { repo, runRoot } = await repository();
  const head = await git(repo, "rev-parse", "HEAD");
  const path = join(runRoot, "workspace");

  const workspace = await createWorkspace({
    repository: repo,
    path,
    runId: "20260918-120000-abcd",
  });

  assert.deepEqual(workspace, {
    path,
    targetFolder: repo,
    isolateKind: "worktree",
    repositoryPath: repo,
    baseCommit: head,
    branch: "loopfile/20260918-120000-abcd",
  });
  assert.equal(await git(path, "rev-parse", "--abbrev-ref", "HEAD"), workspace.branch);
  assert.equal(await git(path, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(path, "README.md"), "utf8"), "hello\n");
  assert.match(await git(repo, "worktree", "list"), new RegExp(path));
});

test("the target repository's own checkout is left as it was", async () => {
  const { repo, runRoot } = await repository();
  await createWorkspace({ repository: repo, path: join(runRoot, "workspace"), runId: "r1" });
  assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(await git(repo, "status", "--porcelain"), "");
});

test("a dirty target repository counts its files and the workspace starts clean from HEAD", async () => {
  const { repo, runRoot } = await repository();
  await writeFile(join(repo, "README.md"), "changed\n");
  await writeFile(join(repo, "new.txt"), "untracked\n");
  assert.equal(await uncommittedFiles(repo), 2);

  const path = join(runRoot, "workspace");
  await createWorkspace({ repository: repo, path, runId: "r1" });

  assert.equal(await readFile(join(path, "README.md"), "utf8"), "hello\n");
  assert.equal(await git(path, "status", "--porcelain"), "");
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "changed\n");
});

test("the dirty warning names the count, and a clean repository gets none", () => {
  assert.equal(dirtyRepositoryWarning(0), undefined);
  assert.equal(
    dirtyRepositoryWarning(1),
    "warning: the target repository has 1 uncommitted file. The workspace starts from HEAD without it.",
  );
  assert.equal(
    dirtyRepositoryWarning(3),
    "warning: the target repository has 3 uncommitted files. The workspace starts from HEAD without them.",
  );
});

test("a repository with no commits gets a full copy instead of a worktree", async () => {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await writeFile(join(repo, "untracked.txt"), "untracked\n");
  const path = join(root, "workspace");

  assert.deepEqual(await createWorkspace({ repository: repo, path, runId: "r1" }), {
    path,
    targetFolder: repo,
    isolateKind: "copy",
  });
  assert.equal(await readFile(join(path, "untracked.txt"), "utf8"), "untracked\n");
});

test("a git failure is a WorkspaceError with git's own message", async () => {
  const { repo, runRoot } = await repository();
  const path = join(runRoot, "workspace");
  await createWorkspace({ repository: repo, path, runId: "r1" });
  // The same run branch again: git refuses, and the reason must reach the user.
  await assert.rejects(
    createWorkspace({ repository: repo, path: join(runRoot, "other"), runId: "r1" }),
    (error: Error) =>
      error instanceof WorkspaceError &&
      /loopfile\/r1/.test(error.message) &&
      /already/.test(error.message),
  );
});

function commandStep(id: string, runLine: string): CommandStep {
  return {
    id,
    kind: "command",
    run: runLine,
    on: {},
    onFailure: "$failure",
    outputs: {},
    maxAttempts: 5,
    timeoutMs: 3_600_000,
  };
}

test("every attempt works in the workspace, and a cycle keeps the commits of earlier attempts", async () => {
  const { repo, runRoot } = await repository();
  const workspace = await createWorkspace({
    repository: repo,
    path: join(runRoot, "workspace"),
    runId: "r1",
  });
  const executor = localExecutor(gitEnv, 200);

  const steps = [
    commandStep(
      "implement",
      'echo one > work.txt && git add work.txt && git commit -qm one && echo "$LOOPFILE_WORKSPACE"',
    ),
    commandStep("review", 'echo "$LOOPFILE_WORKSPACE"'),
    commandStep(
      "implement",
      'test "$(cat work.txt)" = one && git log --format=%s -1 && echo "$LOOPFILE_WORKSPACE"',
    ),
  ];
  const seen: string[] = [];
  for (const [index, step] of steps.entries()) {
    const attemptId = `00${index + 1}-${step.id}`;
    const attempt = await createAttemptDirectory(join(runRoot, "attempts"), attemptId);
    const context: ExecutionContext = {
      runId: "r1",
      attemptId,
      stepId: step.id,
      workspace: workspace.path,
      scratch: attempt.scratch,
      endpoint: attempt.socket,
      attemptSecret: "s3cret",
    };
    const started = await startCommandStep(executor, step, context, attempt);
    assert.equal(started.kind, "running");
    if (started.kind !== "running") return;
    assert.equal((await started.ended).reason, "clean_exit", step.run);
    seen.push(await readFile(attemptPaths(join(runRoot, "attempts"), attemptId).stdout, "utf8"));
  }

  assert.deepEqual(seen, [
    `${workspace.path}\n`,
    `${workspace.path}\n`,
    `one\n${workspace.path}\n`,
  ]);
  if (workspace.isolateKind !== "worktree") throw new Error("expected a Git worktree");
  assert.equal(await git(repo, "log", "--format=%s", "-1", workspace.branch), "one");
  assert.equal(await git(repo, "status", "--porcelain"), "");
});
