import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { pruneCommand } from "./prune-command.ts";
import { removeCommand } from "./remove-command.ts";
import { runPaths } from "./run-directory.ts";
import { startRunOwner } from "./run-owner.ts";

const run = promisify(execFile);
const root = await realpath(await mkdtemp("/tmp/loopfile-remove-"));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
after(() => rm(root, { recursive: true, force: true }));
let number = 0;

async function setup() {
  number += 1;
  const base = join(root, String(number));
  const repo = join(base, "repo");
  const home = join(base, "home");
  const runId = "20260921-120000-aaaa";
  const paths = runPaths(home, runId);
  await mkdir(repo, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo, env: gitEnv });
  await mkdir(paths.root, { recursive: true });
  await run("git", ["worktree", "add", "-q", "-b", `loopfile/${runId}`, paths.workspace, "HEAD"], {
    cwd: repo,
    env: gitEnv,
  });
  const at = new Date().toISOString();
  await writeFile(
    paths.events,
    [
      {
        seq: 1,
        at,
        type: "run.created",
        runId,
        eventFormatVersion: 1,
        modelDigest: "digest",
        targetFolder: repo,
        workspacePath: paths.workspace,
        workspaceMode: "isolate",
        isolateKind: "worktree",
        baseCommit: "0".repeat(40),
        branch: `loopfile/${runId}`,
        inputs: [],
      },
      { seq: 2, at, type: "owner.started", pid: 1, host: hostname() },
      { seq: 3, at, type: "run.ended", result: "success", reason: "end_state" },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
  return { env: { ...gitEnv, LOOPFILE_HOME: home }, repo, home, runId, paths };
}

async function remove(env: NodeJS.ProcessEnv, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await removeCommand(
    ["remove", ...args],
    (text) => (out += text),
    (text) => (err += text),
    env,
    {
      pingTimeoutMs: 100,
    },
  );
  return { code, out, err };
}

test("removes a clean workspace and keeps the run branch", async () => {
  const run = await setup();
  const result = await remove(run.env, run.runId);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "");
  assert.equal(result.err, `removed: ${run.runId}\nbranch: loopfile/${run.runId} (kept)\n`);
  await assert.rejects(stat(run.paths.root));
  const branches = await runGit(run.repo, "branch", "--list", `loopfile/${run.runId}`);
  assert.match(branches, new RegExp(`loopfile/${run.runId}`));
});

test("removes a copy without Git and does not report a branch", async () => {
  const run = await setup();
  await rm(run.paths.workspace, { recursive: true, force: true });
  const workspacePath = join(run.home, "recorded-copy");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, "output.txt"), "keep until explicit removal\n");
  const lines = (await readFile(run.paths.events, "utf8")).trimEnd().split("\n");
  const created = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  created.workspacePath = workspacePath;
  created.targetFolder = join(run.home, "missing-target");
  created.workspaceMode = "isolate";
  created.isolateKind = "copy";
  delete created.branch;
  delete created.baseCommit;
  lines[0] = JSON.stringify(created);
  await writeFile(run.paths.events, `${lines.join("\n")}\n`);

  const result = await remove({ ...run.env, PATH: "" }, run.runId);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, `removed: ${run.runId}\n`);
  await assert.rejects(stat(run.paths.root));
  await assert.rejects(stat(workspacePath));
  await assert.rejects(stat(run.paths.workspace));
});

test("removes an empty workspace without a recorded Target folder or Git", async () => {
  const run = await setup();
  await runGit(run.repo, "worktree", "remove", "--force", run.paths.workspace);
  await mkdir(run.paths.workspace);
  await writeFile(join(run.paths.workspace, "output.txt"), "keep until removal\n");
  const lines = (await readFile(run.paths.events, "utf8")).trimEnd().split("\n");
  const created = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  created.workspacePath = run.paths.workspace;
  created.workspaceMode = "empty";
  for (const field of ["targetFolder", "isolateKind", "branch", "baseCommit"])
    delete created[field];
  lines[0] = JSON.stringify(created);
  await writeFile(run.paths.events, `${lines.join("\n")}\n`);

  const result = await remove({ ...run.env, PATH: "" }, run.runId);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, `removed: ${run.runId}\n`);
  await assert.rejects(stat(run.paths.root));
  await assert.rejects(stat(run.paths.workspace));
  assert.equal((await stat(run.repo)).isDirectory(), true);
});

test("accepts --force for copy and empty workspaces", async () => {
  for (const mode of ["copy", "empty"] as const) {
    const run = await setup();
    await runGit(run.repo, "worktree", "remove", "--force", run.paths.workspace);
    await mkdir(run.paths.workspace);
    await writeFile(join(run.paths.workspace, "uncommitted.txt"), "discard\n");
    const lines = (await readFile(run.paths.events, "utf8")).trimEnd().split("\n");
    const created = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    created.workspacePath = run.paths.workspace;
    created.workspaceMode = mode === "empty" ? "empty" : "isolate";
    if (mode === "copy") {
      created.isolateKind = "copy";
    } else {
      delete created.targetFolder;
      delete created.isolateKind;
    }
    delete created.branch;
    delete created.baseCommit;
    lines[0] = JSON.stringify(created);
    await writeFile(run.paths.events, `${lines.join("\n")}\n`);

    const result = await remove({ ...run.env, PATH: "" }, run.runId, "--force");
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, `removed: ${run.runId}\n`);
    await assert.rejects(stat(run.paths.root));
  }
});

test("removing a here run preserves the target folder without Git", async () => {
  const run = await setup();
  await runGit(run.repo, "worktree", "remove", "--force", run.paths.workspace);
  const userFile = join(run.repo, "user.txt");
  await writeFile(userFile, "keep me\n");
  const lines = (await readFile(run.paths.events, "utf8")).trimEnd().split("\n");
  const created = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  created.workspacePath = run.repo;
  created.workspaceMode = "here";
  delete created.isolateKind;
  delete created.branch;
  delete created.baseCommit;
  lines[0] = JSON.stringify(created);
  await writeFile(run.paths.events, `${lines.join("\n")}\n`);

  const result = await remove({ ...run.env, PATH: "" }, run.runId, "--force");
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, `removed: ${run.runId}\n`);
  assert.equal(await readFile(userFile, "utf8"), "keep me\n");
  await assert.rejects(stat(run.paths.root));
});

test("does not remove a run with a live owner", async () => {
  const run = await setup();
  const owner = await startRunOwner({ home: run.home, runId: run.runId });
  try {
    const result = await remove(run.env, run.runId);
    assert.equal(result.code, 2);
    assert.match(result.err, /\ncode: owner_alive\n/);
    assert.equal((await stat(run.paths.root)).isDirectory(), true);
  } finally {
    await owner.close();
  }
});

test("does not remove a dirty workspace", async () => {
  const run = await setup();
  await writeFile(join(run.paths.workspace, "uncommitted.txt"), "keep\n");
  const result = await remove(run.env, run.runId);
  assert.equal(result.code, 1);
  assert.match(result.err, /^error: /);
  assert.match(result.err, /\ncode: workspace_dirty\n/);
  assert.match(result.err, new RegExp(`loopfile remove ${run.runId} --force`));
  assert.equal((await stat(run.paths.root)).isDirectory(), true);
  assert.equal((await stat(run.paths.workspace)).isDirectory(), true);
});

test("removes a dirty workspace with --force and keeps the run branch", async () => {
  const run = await setup();
  await writeFile(join(run.paths.workspace, "uncommitted.txt"), "lose\n");
  const result = await remove(run.env, run.runId, "--force");
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, new RegExp(`removed: ${run.runId}`));
  await assert.rejects(stat(run.paths.root));
  assert.match(await runGit(run.repo, "branch", "--list", `loopfile/${run.runId}`), /loopfile/);
});

test("prunes a missing workspace before removing the run folder", async () => {
  const run = await setup();
  await rm(run.paths.workspace, { recursive: true });
  const result = await remove(run.env, run.runId);
  assert.equal(result.code, 0, result.err);
  assert.equal((result.err.match(/^warning:/gm) ?? []).length, 1);
  assert.match(result.err, /^warning: workspace is gone/);
  assert.match(result.err, new RegExp(`removed: ${run.runId}`));
  assert.doesNotMatch(await runGit(run.repo, "worktree", "list"), new RegExp(run.paths.workspace));
  assert.match(await runGit(run.repo, "branch", "--list", `loopfile/${run.runId}`), /loopfile/);
});

test("removes a worktree when its repository is gone, with or without --force", async () => {
  for (const args of [[], ["--force"]]) {
    const run = await setup();
    await rm(run.repo, { recursive: true });
    const result = await remove(run.env, run.runId, ...args);
    assert.equal(result.code, 0, result.err);
    await assert.rejects(stat(run.paths.root));
    await assert.rejects(stat(run.paths.workspace));
  }
});

test("warns once and removes a run whose recorded workspace is already gone", async () => {
  const run = await setup();
  await rm(run.paths.workspace, { recursive: true });
  const result = await remove(run.env, run.runId);
  assert.equal(result.code, 0, result.err);
  assert.equal((result.err.match(/^warning:/gm) ?? []).length, 1);
  assert.match(result.err, /warning: workspace is gone/);
  assert.match(result.err, new RegExp(`removed: ${run.runId}`));
  await assert.rejects(stat(run.paths.root));
});

test("here removal does not inspect a missing user folder", async () => {
  const run = await setup();
  await runGit(run.repo, "worktree", "remove", "--force", run.paths.workspace);
  const lines = (await readFile(run.paths.events, "utf8")).trimEnd().split("\n");
  const created = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  created.workspacePath = run.repo;
  created.workspaceMode = "here";
  delete created.isolateKind;
  delete created.branch;
  delete created.baseCommit;
  lines[0] = JSON.stringify(created);
  await writeFile(run.paths.events, `${lines.join("\n")}\n`);
  await rm(run.repo, { recursive: true });

  const result = await remove({ ...run.env, PATH: "" }, run.runId);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, `removed: ${run.runId}\n`);
  await assert.rejects(stat(run.paths.root));
});

test("prune removes mixed workspace modes and skips only a dirty worktree", async () => {
  const worktree = await setup();
  await writeFile(join(worktree.paths.workspace, "uncommitted.txt"), "keep\n");
  const runIds = ["20260921-120001-aaaa", "20260921-120001-bbbb", "20260921-120001-cccc"];
  const [copyId, emptyId, hereId] = runIds;
  assert.ok(copyId && emptyId && hereId);
  const userFile = join(worktree.repo, "user.txt");
  await writeFile(userFile, "preserve\n");
  const at = new Date().toISOString();

  for (const [runId, mode] of [
    [copyId, "isolate"],
    [emptyId, "empty"],
    [hereId, "here"],
  ] as const) {
    const paths = runPaths(worktree.home, runId);
    await mkdir(paths.root, { recursive: true });
    const workspacePath = mode === "here" ? worktree.repo : paths.workspace;
    if (mode !== "here") {
      await mkdir(workspacePath);
      await writeFile(join(workspacePath, "uncommitted.txt"), "discard\n");
      if (mode === "isolate") await rm(workspacePath, { recursive: true });
    }
    await writeFile(
      paths.events,
      [
        {
          seq: 1,
          at,
          type: "run.created",
          runId,
          eventFormatVersion: 1,
          modelDigest: "digest",
          workspacePath,
          workspaceMode: mode,
          ...(mode === "isolate" ? { targetFolder: worktree.repo, isolateKind: "copy" } : {}),
          ...(mode === "here" ? { targetFolder: worktree.repo } : {}),
          inputs: [],
        },
        { seq: 2, at, type: "run.ended", result: "success", reason: "end_state" },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
    );
  }

  let report = "";
  const code = await pruneCommand(
    ["prune"],
    () => undefined,
    (text) => (report += text),
    worktree.env,
  );
  assert.equal(code, 1, report);
  assert.match(report, /removed: 3/);
  assert.match(report, /skipped: 1/);
  assert.equal((report.match(/^warning:/gm) ?? []).length, 1);
  assert.equal((await stat(worktree.paths.root)).isDirectory(), true);
  for (const runId of runIds)
    await assert.rejects(stat(runPaths(worktree.home, runId).root), runId);
  assert.equal(await readFile(userFile, "utf8"), "preserve\n");
});

test("refuses leftover processes unless asked to kill them", async () => {
  const run = await setup();
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  const text = await readFile(run.paths.events, "utf8");
  const at = new Date().toISOString();
  await writeFile(
    run.paths.events,
    text.replace(
      /\{"seq":3,/,
      `{"seq":3,"at":"${at}","type":"attempt.started","attemptId":"001-only","stepId":"only","processGroupId":${child.pid}}\n{"seq":4,`,
    ),
  );
  const refused = await remove(run.env, run.runId);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /\ncode: leftover_processes\n/);
  assert.equal((await stat(run.paths.root)).isDirectory(), true);
  const done = await remove(run.env, run.runId, "--kill-leftovers");
  assert.equal(done.code, 0, done.err);
});

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env: gitEnv })).stdout;
}
