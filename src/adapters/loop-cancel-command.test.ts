import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loopStatus } from "../application/loop-status.ts";
import { parseEventLog } from "../application/replay.ts";
import type { LoopEvent, RunEvent } from "../domain/events.ts";
import { cancelCommand } from "./cancel-command.ts";
import { loopCommand } from "./loop-command.ts";
import { ownerPids, removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { loopPaths, runPaths } from "./run-directory.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-loop-cancel-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

async function setup(command: string) {
  const dir = join(root, `case-${++count}`);
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
  return { dir, home, repo, source, env };
}

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      out: (text: string | Uint8Array) => {
        out += typeof text === "string" ? text : Buffer.from(text).toString();
      },
      err: (text: string) => {
        err += text;
      },
      upgrade: {
        out: () => undefined,
        err: () => undefined,
        isTTY: false,
        ask: async () => null,
      },
    },
    out: () => out,
    err: () => err,
  };
}

async function startLoop(setupResult: Awaited<ReturnType<typeof setup>>, pause?: string) {
  const captured = capture();
  const args = [
    "loop",
    setupResult.source,
    "--times",
    "2",
    ...(pause ? ["--pause", pause] : []),
    "-d",
  ];
  assert.equal(
    await loopCommand(args, cli, captured.io, setupResult.env, { repository: setupResult.repo }),
    0,
    captured.err(),
  );
  return captured.out().trim();
}

async function cancel(id: string, flag?: string, env: NodeJS.ProcessEnv = process.env) {
  const captured = capture();
  const code = await cancelCommand(
    ["cancel", id, ...(flag === undefined ? [] : [flag])],
    () => undefined,
    (text) => {
      captured.io.err(text);
    },
    env,
    { answerTimeoutMs: 500, waitMs: 5_000 },
  );
  return { code, out: captured.out(), err: captured.err() };
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let tries = 0; tries < 1_000; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function loopEvents(home: string, loopId: string): Promise<readonly LoopEvent[]> {
  return parseEventLog<LoopEvent>(await readFile(loopPaths(home, loopId).events, "utf8"));
}

async function runEvents(home: string, runId: string): Promise<readonly RunEvent[]> {
  return parseEventLog<RunEvent>(
    await readFile(runPaths(home, runId).events, "utf8").catch(() => ""),
  );
}

async function firstRun(home: string, loopId: string): Promise<string> {
  return await until(async () => {
    const event = (await loopEvents(home, loopId)).find((item) => item.type === "loop.run_started");
    return event?.type === "loop.run_started" ? event.runId : undefined;
  }, "the child run to start");
}

async function waitForRunAttempt(home: string, runId: string): Promise<void> {
  await until(
    async () =>
      (await runEvents(home, runId)).some((event) => event.type === "attempt.started")
        ? true
        : undefined,
    "the child attempt to start",
  );
}

async function endedLoop(home: string, loopId: string): Promise<readonly LoopEvent[]> {
  return await until(async () => {
    const events = await loopEvents(home, loopId);
    return events.at(-1)?.type === "loop.ended" ? events : undefined;
  }, "the loop to end");
}

test("--now cancels the child and loop without starting another run", async () => {
  const setupResult = await setup("sleep 60");
  try {
    const loopId = await startLoop(setupResult);
    const runId = await firstRun(setupResult.home, loopId);
    await waitForRunAttempt(setupResult.home, runId);
    const result = await cancel(loopId, "--now", setupResult.env);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "");
    assert.equal(result.err, `cancelled: ${loopId} (now)\n`);

    const child = await runEvents(setupResult.home, runId);
    assert.equal(child.at(-1)?.type, "run.cancelled");
    const events = await endedLoop(setupResult.home, loopId);
    assert.deepEqual(
      events.filter((event) => event.type === "loop.run_started").map((event) => event.runId),
      [runId],
    );
    const requested = events.find((event) => event.type === "loop.cancel_requested");
    assert.equal(requested?.type, "loop.cancel_requested");
    if (requested?.type === "loop.cancel_requested") assert.equal(requested.mode, "now");
    const end = events.at(-1);
    assert.equal(end?.type, "loop.ended");
    if (end?.type === "loop.ended") {
      assert.equal(end.reason, "cancelled");
      assert.equal(end.cancelMode, "now");
    }
    assert.equal(loopStatus(events).state, "cancelled");
    assert.equal(loopStatus(events).cancelMode, "now");
  } finally {
    await removeAfterOwnersExit(setupResult.dir);
  }
});

test("--after-run lets the child complete and does not start another run", async () => {
  const setupResult = await setup("sleep 0.5");
  try {
    const loopId = await startLoop(setupResult);
    const runId = await firstRun(setupResult.home, loopId);
    await waitForRunAttempt(setupResult.home, runId);
    const result = await cancel(loopId, "--after-run", setupResult.env);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, `cancelled: ${loopId} (after_run)\n`);

    assert.equal((await runEvents(setupResult.home, runId)).at(-1)?.type, "run.ended");
    const events = await endedLoop(setupResult.home, loopId);
    assert.deepEqual(
      events.filter((event) => event.type === "loop.run_started").map((event) => event.runId),
      [runId],
    );
    const end = events.at(-1);
    assert.equal(end?.type, "loop.ended");
    if (end?.type === "loop.ended") {
      assert.equal(end.reason, "cancelled");
      assert.equal(end.cancelMode, "after_run");
    }
    assert.equal(loopStatus(events).state, "cancelled");
    assert.equal(loopStatus(events).cancelMode, "after_run");
  } finally {
    await removeAfterOwnersExit(setupResult.dir);
  }
});

test("cancel during a 30-second pause ends the loop promptly", async () => {
  const setupResult = await setup("true");
  try {
    const loopId = await startLoop(setupResult, "30s");
    await until(
      async () =>
        (await loopEvents(setupResult.home, loopId)).some((event) => event.type === "loop.paused")
          ? true
          : undefined,
      "the loop to pause",
    );
    const started = Date.now();
    const result = await cancel(loopId, "--now", setupResult.env);
    assert.equal(result.code, 0, result.err);
    assert.ok(Date.now() - started < 3_000, "cancellation should interrupt the pause");
    const events = await endedLoop(setupResult.home, loopId);
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 1);
    const end = events.at(-1);
    assert.equal(end?.type, "loop.ended");
    if (end?.type === "loop.ended") assert.equal(end.cancelMode, "now");
  } finally {
    await removeAfterOwnersExit(setupResult.dir);
  }
});

test("cancelling a child run ends its loop as failed with run_failed", async () => {
  const setupResult = await setup("sleep 60");
  try {
    const loopId = await startLoop(setupResult);
    const runId = await firstRun(setupResult.home, loopId);
    await waitForRunAttempt(setupResult.home, runId);
    const result = await cancel(runId, undefined, setupResult.env);
    assert.equal(result.code, 0, result.err);
    const events = await endedLoop(setupResult.home, loopId);
    const end = events.at(-1);
    assert.equal(end?.type, "loop.ended");
    if (end?.type === "loop.ended") {
      assert.equal(end.reason, "run_failed");
      assert.equal(end.result, "failure");
    }
  } finally {
    await removeAfterOwnersExit(setupResult.dir);
  }
});

test("loop cancel reports missing, ended, and unavailable owners and requires a mode", async () => {
  const setupResult = await setup("true");
  try {
    const missing = await cancel("loop-20260101-000000-none", "--now", setupResult.env);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /code: no_such_loop/);

    const loopId = await startLoop(setupResult);
    await endedLoop(setupResult.home, loopId);
    const ended = await cancel(loopId, "--now", setupResult.env);
    assert.equal(ended.code, 0);
    assert.equal(ended.err, `ended: ${loopId}\ncode: already_ended\n`);

    const runningSetup = await setup("true");
    const liveLoopId = await startLoop(runningSetup, "30s");
    await until(
      async () =>
        (await loopEvents(runningSetup.home, liveLoopId)).some(
          (event) => event.type === "loop.paused",
        )
          ? true
          : undefined,
      "the loop to pause",
    );
    let missingModeErr = "";
    const missingMode = await cancelCommand(
      ["cancel", liveLoopId],
      () => undefined,
      (text) => {
        missingModeErr += text;
      },
      runningSetup.env,
    );
    assert.equal(missingMode, 2);
    assert.match(missingModeErr, /--now.*--after-run/);
    assert.match(missingModeErr, /code: bad_argument/);

    const [owner] = await ownerPids(loopPaths(runningSetup.home, liveLoopId).events);
    assert.ok(owner !== undefined);
    process.kill(owner, "SIGKILL");
    const gone = await cancel(liveLoopId, "--after-run", runningSetup.env);
    assert.equal(gone.code, 2);
    assert.match(gone.err, /code: owner_gone/);
    assert.match(gone.err, new RegExp(`loopfile resume ${liveLoopId}`));
    await removeAfterOwnersExit(runningSetup.dir);
  } finally {
    await removeAfterOwnersExit(setupResult.dir);
  }
});
