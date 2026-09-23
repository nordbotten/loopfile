import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import { interruptCommand } from "./interrupt-command.ts";
import { type LaunchIo, launchCommand } from "./launch-command.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { pathExists, type RunPaths, runPaths } from "./run-directory.ts";
import { requestCancel, startRunOwner } from "./run-owner.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-interrupt-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function setup(manifest: string) {
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
  await writeFile(join(source, "manifest.yaml"), manifest);
  return { home, repo, source, env };
}

async function launch(manifest: string) {
  const setupResult = await setup(manifest);
  let out = "";
  const io: LaunchIo = {
    out: (text) => {
      out += text;
    },
    err: () => undefined,
    upgrade: { out: () => undefined, err: () => undefined, isTTY: false, ask: async () => null },
    monitor: { input: process.stdin, output: process.stdout } as unknown as MonitorIo,
  };
  assert.equal(
    await launchCommand([setupResult.source, "-d"], cli, io, setupResult.env, {
      repository: setupResult.repo,
    }),
    0,
  );
  const runId = out.trim();
  return { ...setupResult, runId, paths: runPaths(setupResult.home, runId) };
}

async function events(paths: RunPaths) {
  return parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let tries = 0; tries < 500; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function interrupt(runId: string, env: NodeJS.ProcessEnv) {
  let err = "";
  const code = await interruptCommand(
    ["interrupt", runId],
    () => undefined,
    (text) => {
      err += text;
    },
    env,
    { answerTimeoutMs: 500, waitMs: 5_000 },
  );
  return { code, err };
}

const SLEEP = (maxAttempts: number) => `formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: ${maxAttempts}
    run: sleep 30
`;

test("interrupt confirms after starting the same step's next attempt", async () => {
  const { runId, env, paths } = await launch(SLEEP(3));
  await until(
    async () =>
      (await events(paths)).some((event) => event.type === "attempt.started") ? true : undefined,
    "the first attempt",
  );
  const result = await interrupt(runId, env);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, `interrupted: ${runId}\n`);
  await until(async () => {
    if ((await events(paths)).filter((event) => event.type === "attempt.started").length !== 2)
      return undefined;
    const status = JSON.parse(await readFile(paths.status, "utf8").catch(() => "null"));
    return status?.current?.attempt === 2 ? true : undefined;
  }, "the replacement attempt in status");
  const status = JSON.parse(await readFile(paths.status, "utf8"));
  assert.equal(status.current.attempt, 2);
  assert.equal(await requestCancel(paths.socket, runId), true);
  await until(
    async () => ((await pathExists(paths.socket)) ? undefined : true),
    "the owner to stop",
  );
});

test("interrupting the last allowed attempt ends with attempt_limit", async () => {
  const { runId, env, paths } = await launch(SLEEP(1));
  await until(
    async () =>
      (await events(paths)).some((event) => event.type === "attempt.started") ? true : undefined,
    "the attempt",
  );
  const result = await interrupt(runId, env);
  assert.equal(result.code, 0, result.err);
  const end = (await events(paths)).at(-1);
  assert.equal(end?.type === "run.ended" && end.reason, "attempt_limit");
});

test("interrupt validates its run ID and event log before asking the owner", async () => {
  let err = "";
  assert.equal(
    await interruptCommand(
      ["interrupt"],
      () => undefined,
      (text) => (err += text),
      {},
    ),
    2,
  );
  assert.match(err, /takes one run ID/);

  err = "";
  assert.equal(
    await interruptCommand(
      ["interrupt", "missing"],
      () => undefined,
      (text) => (err += text),
      { LOOPFILE_HOME: join(root, "missing-home") },
    ),
    2,
  );
  assert.match(err, /no run missing/);

  const broken = await setup(SLEEP(1));
  await mkdir(runPaths(broken.home, "broken").root, { recursive: true });
  err = "";
  assert.equal(
    await interruptCommand(
      ["interrupt", "broken"],
      () => undefined,
      (text) => (err += text),
      broken.env,
    ),
    2,
  );
  assert.match(err, /events.jsonl/);
});

test("interrupt reports ended, crashed and between-attempt runs instead of queueing", async (t) => {
  const ended = await launch(`formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    onFailure: $failure\n    run: exit 1\n`);
  await until(
    async () => ((await events(ended.paths)).at(-1)?.type === "run.ended" ? true : undefined),
    "the run to end",
  );
  const endedResult = await interrupt(ended.runId, ended.env);
  assert.equal(endedResult.code, 2);
  assert.match(endedResult.err, /has ended/);
  assert.match(endedResult.err, /loopfile continue/);
  assert.match(endedResult.err, /help:/);

  const crashed = await launch(SLEEP(2));
  const owner = await until(async () => {
    const found = (await events(crashed.paths)).find((event) => event.type === "owner.started");
    return found?.type === "owner.started" ? found.pid : undefined;
  }, "the owner");
  process.kill(owner, "SIGKILL");
  const group = (await events(crashed.paths)).find((event) => event.type === "attempt.started");
  if (group?.type === "attempt.started") process.kill(-group.processGroupId, "SIGKILL");
  const crashedResult = await interrupt(crashed.runId, crashed.env);
  assert.equal(crashedResult.code, 2);
  assert.match(crashedResult.err, /loopfile resume/);
  assert.match(crashedResult.err, /help:/);

  const home = join(root, "between-home");
  const runId = "20260922-160000-between";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  const live = await startRunOwner({ home, runId });
  t.after(() => live.close());
  const noAttempt = await interrupt(runId, { LOOPFILE_HOME: home });
  assert.equal(noAttempt.code, 2);
  assert.match(noAttempt.err, /no attempt is running/);
  assert.match(noAttempt.err, /help:/);
});
