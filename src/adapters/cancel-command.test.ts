import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import { cancelCommand } from "./cancel-command.ts";
import { type LaunchIo, launchCommand } from "./launch-command.ts";
import { groupAlive } from "./local-executor.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { pathExists, type RunPaths, runPaths } from "./run-directory.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-cancel-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

/** A target repository and a Loopfile whose one command step runs `command`. */
async function setup(command: string) {
  count += 1;
  const dir = join(root, `case-${count}`);
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const source = join(dir, "source");
  await mkdir(home, { recursive: true });
  await mkdir(repo);
  await mkdir(source);
  const env = { ...process.env, ...gitEnv, LOOPFILE_HOME: home };
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  await run("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo, env });
  await writeFile(
    join(source, "manifest.yaml"),
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: ${JSON.stringify(command)}\n`,
  );
  return { home, repo, source, env };
}

/** Starts a run detached, the way `loopfile <source> -d` does. */
async function launch(command: string) {
  const { home, repo, source, env } = await setup(command);
  let out = "";
  const io: LaunchIo = {
    out: (text) => {
      out += text;
    },
    err: () => undefined,
    upgrade: { out: () => undefined, err: () => undefined, isTTY: false, ask: async () => null },
    monitor: { input: new PassThrough(), output: new PassThrough() } as unknown as MonitorIo,
  };
  assert.equal(await launchCommand([source, "-d"], cli, io, env, { repository: repo }), 0);
  const runId = out.trim();
  return { runId, env, paths: runPaths(home, runId) };
}

async function cancel(runId: string, env: NodeJS.ProcessEnv) {
  let out = "";
  let err = "";
  const code = await cancelCommand(
    ["cancel", runId],
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
    env,
    { answerTimeoutMs: 500 },
  );
  return { code, out, err };
}

async function events(paths: RunPaths): Promise<readonly RunEvent[]> {
  return parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let tries = 0; tries < 1000; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The running attempt's process group and the run owner's pid, once the attempt has started. */
async function running(paths: RunPaths): Promise<{ group: number; owner: number }> {
  return await until(async () => {
    const all = await events(paths);
    const started = all.find((e) => e.type === "attempt.started");
    const owner = all.find((e) => e.type === "owner.started");
    if (started?.type !== "attempt.started" || owner?.type !== "owner.started") return undefined;
    return { group: started.processGroupId, owner: owner.pid };
  }, "attempt.started");
}

/** Every regular file under `dir`, path to bytes. Sockets are left out. */
async function files(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.set(path, await readFile(path, "base64"));
  }
  return found;
}

function assertCancelled(all: readonly RunEvent[]) {
  assert.deepEqual(
    all.slice(-2).map((event) => event.type),
    ["attempt.interrupted", "run.cancelled"],
  );
}

test("cancel stops an active run, and a child that ignores SIGTERM is killed after about 10 seconds", async () => {
  const { runId, env, paths } = await launch("trap '' TERM; sleep 60");
  const { group } = await running(paths);

  const started = Date.now();
  const cancelled = await cancel(runId, env);
  const took = Date.now() - started;
  assert.equal(cancelled.code, 0, cancelled.err);
  assert.equal(cancelled.out, "");
  assert.equal(cancelled.err, `cancelled: ${runId}\n`);
  assert.ok(took >= 9_000 && took < 15_000, `cancel took ${took} ms`);

  assertCancelled(await events(paths));
  assert.equal(groupAlive(group), false, "no process of the attempt's group is left");
  assert.equal(await pathExists(paths.socket), false, "the socket is gone");
  assert.equal(await pathExists(paths.workspace), true, "cancel keeps the workspace");

  const repeated = await cancel(runId, env);
  assert.equal(repeated.code, 0, repeated.err);
  assert.equal(repeated.out, "");
  assert.equal(repeated.err, `ended: ${runId}\ncode: already_ended\n`);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`${signal} to the run owner ends the run the same way`, async () => {
    const { paths } = await launch("sleep 60");
    const { group, owner } = await running(paths);
    process.kill(owner, signal);
    await until(
      async () => ((await pathExists(paths.socket)) ? undefined : true),
      "the socket to go",
    );
    assertCancelled(await events(paths));
    assert.equal(groupAlive(group), false, "no process of the attempt's group is left");
  });
}

test("an unknown run ID is a clear error", async () => {
  const { env } = await setup("true");
  const result = await cancel("20260101-000000-none", env);
  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.match(result.err, /^error: no run 20260101-000000-none/);
  assert.match(result.err, /\ncode: no_such_run\n/);
});

test("an ended run is a clear error, and cancel writes nothing to it", async () => {
  const { runId, env, paths } = await launch("true");
  await until(async () => ((await pathExists(paths.socket)) ? undefined : true), "the run to end");
  const before = await files(paths.root);
  const result = await cancel(runId, env);
  assert.equal(result.code, 0);
  assert.equal(result.out, "");
  assert.equal(result.err, `ended: ${runId}\ncode: already_ended\n`);
  assert.deepEqual(await files(paths.root), before);
});

test("a run owner that does not answer is a clear error, and cancel writes nothing", async () => {
  const { runId, env, paths } = await launch("sleep 60");
  const { group, owner } = await running(paths);
  process.kill(owner, "SIGKILL");
  process.kill(-group, "SIGKILL");
  await until(async () => (groupAlive(group) ? undefined : true), "the group to die");
  const before = await files(paths.root);

  const result = await cancel(runId, env);
  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.match(result.err, /^error: the run owner of run /);
  assert.match(result.err, /\ncode: owner_gone\n/);
  assert.match(result.err, new RegExp(`loopfile resume ${runId}`));
  assert.deepEqual(await files(paths.root), before);
});

test("cancel takes exactly one run ID", async () => {
  for (const argv of [["cancel"], ["cancel", "a", "b"], ["cancel", "--force"]]) {
    let err = "";
    const code = await cancelCommand(
      argv,
      () => undefined,
      (text) => {
        err += text;
      },
      {},
    );
    assert.equal(code, 2);
    assert.match(err, /Usage: loopfile cancel <runid>/);
  }
});
