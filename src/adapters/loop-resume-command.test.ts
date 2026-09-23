import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import type { LoopEvent, RunEvent } from "../domain/events.ts";
import { cancelCommand } from "./cancel-command.ts";
import { materializeDirectory } from "./directory-loader.ts";
import { openEventLog } from "./event-log.ts";
import { loopCommand } from "./loop-command.ts";
import { loopResumeCommand } from "./loop-resume-command.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { programIdentity } from "./program-identity.ts";
import { resumeCommand } from "./resume-command.ts";
import { createLoopDirectory, loopPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-loop-resume-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

async function setup(manifest: string) {
  const dir = join(root, `case-${++count}`);
  const repo = join(dir, "repo");
  const source = join(dir, "source");
  const home = join(dir, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await run("git", ["commit", "-q", "-m", "first"], {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
  });
  await writeFile(join(source, "manifest.yaml"), manifest);
  return { dir, repo, source, home, env: { ...process.env, ...gitEnv, LOOPFILE_HOME: home } };
}

function session() {
  let out = "";
  let err = "";
  const input = Object.assign(new PassThrough(), { isTTY: false, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: false });
  output.resume();
  return {
    io: {
      out: (text: string | Uint8Array) => {
        out += typeof text === "string" ? text : Buffer.from(text).toString();
      },
      err: (text: string) => {
        err += text;
      },
      monitor: { input, output } as MonitorIo,
    },
    out: () => out,
    err: () => err,
  };
}

async function startLoop(setupResult: Awaited<ReturnType<typeof setup>>, args: readonly string[]) {
  const s = session();
  const code = await loopCommand(
    ["loop", setupResult.source, ...args],
    cli,
    {
      ...s.io,
      upgrade: { out: () => undefined, err: () => undefined, isTTY: false, ask: async () => null },
    },
    setupResult.env,
    { repository: setupResult.repo },
  );
  assert.equal(code, 0, s.err());
  return { loopId: s.out().trim(), err: s.err() };
}

async function resume(args: readonly string[], env: NodeJS.ProcessEnv) {
  const s = session();
  const code = await resumeCommand(["resume", ...args], cli, s.io, env, {
    pingTimeoutMs: 200,
    ownerPingTimeoutMs: 200,
    pollMs: 10,
  });
  return { code, out: s.out(), err: s.err() };
}

async function events(home: string, loopId: string): Promise<readonly LoopEvent[]> {
  return parseEventLog<LoopEvent>(await readFile(loopPaths(home, loopId).events, "utf8"));
}

async function runEvents(home: string, runId: string): Promise<readonly RunEvent[]> {
  return parseEventLog<RunEvent>(
    await readFile(runPaths(home, runId).events, "utf8").catch(() => ""),
  );
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let tries = 0; tries < 1000; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForEnd(home: string, loopId: string): Promise<readonly LoopEvent[]> {
  return await until(async () => {
    const history = await events(home, loopId);
    return history.at(-1)?.type === "loop.ended" ? history : undefined;
  }, "loop.ended");
}

test("loop resume help describes the loop command", async () => {
  const captured = session();
  assert.equal(await loopResumeCommand(["resume", "--help"], cli, captured.io, {}), 0);
  assert.match(captured.out(), /Resume a crashed loop/);
  assert.equal(captured.err(), "");
});

test("resume waits only for the remainder of a recorded loop pause", async () => {
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const { loopId } = await startLoop(setupResult, ["--times", "2", "--pause", "3s", "-d"]);
  const pause = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.paused",
    );
    return event?.type === "loop.paused" ? event : undefined;
  }, "loop to pause");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const owner = (await events(setupResult.home, loopId)).findLast(
    (event) => event.type === "owner.started",
  );
  if (owner?.type !== "owner.started") throw new Error("loop owner did not start");
  process.kill(owner.pid, "SIGKILL");

  const resumedAt = Date.now();
  const resumed = await resume([loopId, "-d"], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  const nextRun = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started" && item.index === 2,
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "next run to start");
  const delay = Date.parse(nextRun.at) - resumedAt;
  const remaining = Date.parse(pause.until) - resumedAt;
  assert.ok(remaining >= 1500 && remaining < 2400, `pause had ${remaining}ms left`);
  assert.ok(delay >= 1500 && delay < 2800, `next run started after ${delay}ms`);
  assert.equal(
    (await waitForEnd(setupResult.home, loopId)).filter((event) => event.type === "loop.paused")
      .length,
    1,
  );
});

test("resume restarts a child whose owner crashed and then continues the loop", async () => {
  const marker = join(root, "resume-child-running");
  const counter = join(root, "resume-child-count");
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`n=$(cat '${counter}' 2>/dev/null || printf 0); n=$((n + 1)); printf '%s\\n' "$n" > '${counter}'; if [ "$n" = 1 ]; then : > '${marker}'; sleep 0.5; fi`)}
`);
  const { loopId } = await startLoop(setupResult, ["--times", "2", "-d"]);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started" && item.index === 1,
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "first child to start");
  const runOwner = await until(async () => {
    const event = (await runEvents(setupResult.home, first.runId)).find(
      (item) => item.type === "owner.started",
    );
    return event?.type === "owner.started" ? event : undefined;
  }, "first child owner to start");
  await until(
    () =>
      stat(marker).then(
        () => true,
        () => undefined,
      ),
    "first child command to run",
  );
  const loopOwner = (await events(setupResult.home, loopId)).find(
    (event) => event.type === "owner.started",
  );
  assert.equal(loopOwner?.type, "owner.started");
  if (loopOwner?.type === "owner.started") process.kill(loopOwner.pid, "SIGKILL");
  process.kill(runOwner.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 600));

  const resumed = await resume([loopId], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  const history = await waitForEnd(setupResult.home, loopId);
  const started = history.filter((event) => event.type === "loop.run_started");
  assert.equal(started.length, 2);
  assert.equal(started[0]?.type === "loop.run_started" ? started[0].runId : undefined, first.runId);
  const childHistory = await runEvents(setupResult.home, first.runId);
  assert.equal(childHistory.filter((event) => event.type === "owner.started").length, 2);
  assert.ok(childHistory.some((event) => event.type === "attempt.interrupted"));
  assert.equal(childHistory.at(-1)?.type, "run.ended");
  assert.equal((await readFile(counter, "utf8")).trim(), "3");
});

test("resume resumes an internal-error child before continuing the loop", async () => {
  const marker = join(root, "resume-internal-error-running");
  const counter = join(root, "resume-internal-error-count");
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`n=$(cat '${counter}' 2>/dev/null || printf 0); n=$((n + 1)); printf '%s\\n' "$n" > '${counter}'; if [ "$n" = 1 ]; then : > '${marker}'; sleep 0.4; fi`)}
`);
  const { loopId } = await startLoop(setupResult, ["--times", "2", "-d"]);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "child to start");
  const runOwner = await until(async () => {
    const event = (await runEvents(setupResult.home, first.runId)).find(
      (item) => item.type === "owner.started",
    );
    return event?.type === "owner.started" ? event : undefined;
  }, "child owner to start");
  await until(
    () =>
      stat(marker).then(
        () => true,
        () => undefined,
      ),
    "child command to run",
  );
  const loopOwner = (await events(setupResult.home, loopId)).find(
    (event) => event.type === "owner.started",
  );
  assert.equal(loopOwner?.type, "owner.started");
  if (loopOwner?.type === "owner.started") process.kill(loopOwner.pid, "SIGKILL");
  process.kill(runOwner.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));

  const childPaths = runPaths(setupResult.home, first.runId);
  const childLog = await openEventLog<RunEvent>(childPaths.events);
  await childLog.append({ type: "run.ended", result: "failure", reason: "internal_error" });
  await childLog.close();
  const projection = JSON.parse(await readFile(childPaths.status, "utf8"));
  await writeFile(
    childPaths.status,
    `${JSON.stringify({ ...projection, state: "failed", endReason: "internal_error" })}\n`,
  );

  const resumed = await resume([loopId], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  const childHistory = await runEvents(setupResult.home, first.runId);
  assert.equal(childHistory.filter((event) => event.type === "owner.started").length, 2);
  assert.ok(childHistory.some((event) => event.type === "attempt.interrupted"));
  assert.equal(childHistory.at(-1)?.type, "run.ended");
  assert.equal((await readFile(counter, "utf8")).trim(), "3");
});

test("a child crash after loop recovery still ends the live loop with internal_error", async () => {
  const marker = join(root, "live-loop-child-running");
  const counter = join(root, "live-loop-child-count");
  const killLoopOwner = `pid=$(grep -m 1 '"type":"owner.started"' "$LOOPFILE_HOME"/loops/*/events.jsonl | sed -E 's/.*"pid":([0-9]+).*/\\1/'); kill -KILL "$pid"`;
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`n=$(cat '${counter}' 2>/dev/null || printf 0); n=$((n + 1)); printf '%s\\n' "$n" > '${counter}'; if [ "$n" = 1 ]; then ${killLoopOwner}; fi; if [ "$n" = 2 ]; then : > '${marker}'; sleep 30; fi`)}
`);
  const { loopId } = await startLoop(setupResult, ["--times", "2", "-d"]);
  const paths = loopPaths(setupResult.home, loopId);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "first child to start");
  await until(
    async () =>
      (await runEvents(setupResult.home, first.runId)).some((event) => event.type === "run.ended")
        ? true
        : undefined,
    "first child to end",
  );
  await until(
    async () => ((await pingOwner(paths.socket, 20)) === undefined ? true : undefined),
    "first loop owner to stop",
  );

  const resumed = await resume([loopId, "-d"], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  const second = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started" && item.index === 2,
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "second child to start");
  const childOwner = await until(async () => {
    const event = (await runEvents(setupResult.home, second.runId)).find(
      (item) => item.type === "owner.started",
    );
    return event?.type === "owner.started" ? event : undefined;
  }, "second child owner to start");
  const attempt = await until(async () => {
    const event = (await runEvents(setupResult.home, second.runId)).find(
      (item) => item.type === "attempt.started",
    );
    return event?.type === "attempt.started" ? event : undefined;
  }, "second child attempt to start");
  await until(
    () =>
      stat(marker).then(
        () => true,
        () => undefined,
      ),
    "second child command to run",
  );

  try {
    process.kill(childOwner.pid, "SIGKILL");
    const history = await waitForEnd(setupResult.home, loopId);
    const ended = history.at(-1);
    assert.equal(ended?.type, "loop.ended");
    if (ended?.type === "loop.ended") {
      assert.equal(ended.reason, "internal_error");
      assert.equal(ended.detail, `child run ${second.runId} crashed`);
    }
    assert.equal(
      (await runEvents(setupResult.home, second.runId)).filter(
        (event) => event.type === "owner.started",
      ).length,
      1,
    );
  } finally {
    try {
      process.kill(-attempt.processGroupId, "SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
});

test("resume retries a failed child using the loop's retry limit", async () => {
  const counter = join(root, "resume-failed-child-count");
  const killLoopOwner = `pid=$(grep -m 1 '"type":"owner.started"' "$LOOPFILE_HOME"/loops/*/events.jsonl | sed -E 's/.*"pid":([0-9]+).*/\\1/'); kill -KILL "$pid"`;
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`n=$(cat '${counter}' 2>/dev/null || printf 0); n=$((n + 1)); printf '%s\\n' "$n" > '${counter}'; if [ "$n" = 1 ]; then ${killLoopOwner}; exit 1; fi`)}
`);
  const { loopId } = await startLoop(setupResult, ["--times", "1", "--retry", "1", "-d"]);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "failed child to start");
  await until(
    async () =>
      (await runEvents(setupResult.home, first.runId)).some((event) => event.type === "run.ended")
        ? true
        : undefined,
    "failed child to end",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual((await events(setupResult.home, loopId)).at(-1)?.type, "loop.ended");

  const resumed = await resume([loopId], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  const history = await waitForEnd(setupResult.home, loopId);
  const started = history.filter(
    (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
      event.type === "loop.run_started",
  );
  assert.equal(started.length, 2);
  assert.equal(started[1]?.retryOf, first.runId);
  assert.equal((await runEvents(setupResult.home, first.runId)).at(-1)?.type, "run.ended");
  assert.equal((await readFile(counter, "utf8")).trim(), "2");
});

test("resume ends cancelled after a pending after-run cancel without starting another run", async () => {
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: 'sleep 0.5'
`);
  const { loopId } = await startLoop(setupResult, ["--times", "2", "-d"]);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "first child to start");
  await until(
    async () =>
      (await runEvents(setupResult.home, first.runId)).some(
        (event) => event.type === "attempt.started",
      )
        ? true
        : undefined,
    "first child attempt to start",
  );
  let cancelError = "";
  assert.equal(
    await cancelCommand(
      ["cancel", loopId, "--after-run"],
      () => undefined,
      (text) => (cancelError += text),
      setupResult.env,
      { answerTimeoutMs: 500, waitMs: 10 },
    ),
    0,
    cancelError,
  );
  const loopOwner = (await events(setupResult.home, loopId)).find(
    (event) => event.type === "owner.started",
  );
  assert.equal(loopOwner?.type, "owner.started");
  if (loopOwner?.type === "owner.started") process.kill(loopOwner.pid, "SIGKILL");
  await until(
    async () =>
      (await runEvents(setupResult.home, first.runId)).some((event) => event.type === "run.ended")
        ? true
        : undefined,
    "first child to complete",
  );

  const resumed = await resume([loopId], setupResult.env);
  assert.equal(resumed.code, 1, resumed.err);
  const history = await waitForEnd(setupResult.home, loopId);
  assert.equal(history.filter((event) => event.type === "loop.run_started").length, 1);
  const end = history.at(-1);
  assert.equal(end?.type, "loop.ended");
  if (end?.type === "loop.ended") {
    assert.equal(end.reason, "cancelled");
    assert.equal(end.detail, undefined);
    assert.equal(end.cancelMode, "after_run");
  }
});

test("loop resume passes --kill-leftovers to the child run resume", async () => {
  const marker = join(root, "resume-kill-leftovers-running");
  const counter = join(root, "resume-kill-leftovers-count");
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`n=$(cat '${counter}' 2>/dev/null || printf 0); n=$((n + 1)); printf '%s\\n' "$n" > '${counter}'; if [ "$n" = 1 ]; then : > '${marker}'; sleep 30; fi`)}
`);
  const { loopId } = await startLoop(setupResult, ["--times", "1", "-d"]);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "child to start");
  const runOwner = await until(async () => {
    const event = (await runEvents(setupResult.home, first.runId)).find(
      (item) => item.type === "owner.started",
    );
    return event?.type === "owner.started" ? event : undefined;
  }, "child owner to start");
  await until(
    () =>
      stat(marker).then(
        () => true,
        () => undefined,
      ),
    "child command to run",
  );
  const loopOwner = (await events(setupResult.home, loopId)).find(
    (event) => event.type === "owner.started",
  );
  assert.equal(loopOwner?.type, "owner.started");
  if (loopOwner?.type === "owner.started") process.kill(loopOwner.pid, "SIGKILL");
  process.kill(runOwner.pid, "SIGKILL");

  const resumed = await resume([loopId, "--kill-leftovers"], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  const childHistory = await runEvents(setupResult.home, first.runId);
  assert.ok(childHistory.some((event) => event.type === "attempt.interrupted"));
  assert.equal((await readFile(counter, "utf8")).trim(), "2");
  const history = await waitForEnd(setupResult.home, loopId);
  const end = history.at(-1);
  assert.equal(end?.type, "loop.ended");
  if (end?.type === "loop.ended") assert.equal(end.reason, "source_empty");
});

test("resume reports a child resume refusal as a loop internal error", async () => {
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: 'sleep 30'
`);
  const { loopId } = await startLoop(setupResult, ["--times", "1", "-d"]);
  const first = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "child to start");
  const runOwner = await until(async () => {
    const event = (await runEvents(setupResult.home, first.runId)).find(
      (item) => item.type === "owner.started",
    );
    return event?.type === "owner.started" ? event : undefined;
  }, "child owner to start");
  const attempt = await until(async () => {
    const event = (await runEvents(setupResult.home, first.runId)).find(
      (item) => item.type === "attempt.started",
    );
    return event?.type === "attempt.started" ? event : undefined;
  }, "child attempt to start");
  const loopOwner = (await events(setupResult.home, loopId)).find(
    (event) => event.type === "owner.started",
  );
  assert.equal(loopOwner?.type, "owner.started");
  if (loopOwner?.type === "owner.started") process.kill(loopOwner.pid, "SIGKILL");
  process.kill(runOwner.pid, "SIGKILL");

  try {
    const resumed = await resume([loopId], setupResult.env);
    assert.equal(resumed.code, 1, resumed.err);
    const history = await waitForEnd(setupResult.home, loopId);
    const ended = history.at(-1);
    assert.equal(ended?.type, "loop.ended");
    if (ended?.type === "loop.ended") {
      assert.equal(ended.reason, "internal_error");
      assert.equal(
        ended.detail,
        `attempt ${attempt.attemptId} still has processes in process group ${attempt.processGroupId}. ` +
          `Stop them with \`kill -KILL -- -${attempt.processGroupId}\`, or run \`loopfile resume ${first.runId} --kill-leftovers\`.`,
      );
    }
  } finally {
    try {
      process.kill(-attempt.processGroupId, "SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
});

test("resume waits for a running second child, starts the third, and completes with three runs", async () => {
  const setupResult = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`n=$(cat '${join(root, "run-count")}' 2>/dev/null || printf 0); n=$((n + 1)); printf '%s\\n' "$n" > '${join(root, "run-count")}'; if [ "$n" = 2 ]; then : > '${join(root, "run-two-running")}'; sleep 1; fi`)}
`);
  const { loopId } = await startLoop(setupResult, ["--times", "3", "-d"]);
  const paths = loopPaths(setupResult.home, loopId);

  const second = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started" && item.index === 2,
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "second run to start");
  await until(
    () =>
      stat(join(root, "run-two-running")).then(
        () => true,
        () => undefined,
      ),
    "second run command to be running",
  );
  const owner = (await events(setupResult.home, loopId)).find(
    (event) => event.type === "owner.started",
  );
  assert.equal(owner?.type, "owner.started");
  if (owner?.type === "owner.started") process.kill(owner.pid, "SIGKILL");
  await until(
    async () => ((await pingOwner(paths.socket, 20)) === undefined ? true : undefined),
    "loop owner to stop",
  );
  assert.equal(await stat(runPaths(setupResult.home, second.runId).root).then(() => true), true);

  const resumedAt = Date.now();
  const resumed = await resume([loopId], setupResult.env);
  assert.ok(Date.now() - resumedAt >= 300, "resume waits for run 2 to finish");
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.out, `${loopId}\n`);
  assert.match(resumed.err, new RegExp(`^resumed: ${loopId}\\n`));
  assert.match(resumed.err, new RegExp(`ended: ${loopId} completed source_empty`));
  const history = await waitForEnd(setupResult.home, loopId);
  const runIds = history
    .filter((event) => event.type === "loop.run_started")
    .map((event) => event.runId);
  assert.equal(runIds.length, 3);
  assert.ok(runIds.includes(second.runId));
  const ended = history.at(-1);
  assert.equal(ended?.type === "loop.ended" ? ended.reason : undefined, "source_empty");
  assert.equal((await readFile(join(root, "run-count"), "utf8")).trim(), "3");
});

test("resume recreates a child missing after loop.run_started without calling --next again", async () => {
  const setupResult = await setup(`formatVersion: 1
inputs:
  n: The saved next input
steps:
  - id: work
    kind: command
    run: ${JSON.stringify(`node ${cli} data get input.n > '${join(root, "recovered-input")}' && sleep 0.3`)}
`);
  const nextCalls = join(root, "next-calls");
  const nextCommand = `printf 'called\\n' >> '${nextCalls}'; printf '%s\\n' '{"n":"saved"}'`;
  const loopId = "loop-20260923-000002-aaaa";
  const paths = await createLoopDirectory({
    home: setupResult.home,
    loopId,
    targetRepository: setupResult.repo,
  });
  await materializeDirectory(setupResult.source, paths.loopfile);
  const log = await openEventLog<LoopEvent>(paths.events);
  await log.append({
    type: "loop.created",
    loopId,
    eventFormatVersion: 1,
    repositoryPath: setupResult.repo,
    loopfileName: "source",
    source: { kind: "next", command: nextCommand },
    fixedInputs: {},
    retry: 0,
    maxRuns: 1,
    pauseMs: null,
    program: await programIdentity(cli),
  });
  await log.close();

  const runner = `
    import { hostname } from "node:os";
    import { openEventLog } from ${JSON.stringify(fileURLToPath(new URL("./event-log.ts", import.meta.url)))};
    import { loopPaths } from ${JSON.stringify(fileURLToPath(new URL("./run-directory.ts", import.meta.url)))};
    import { runLoop } from ${JSON.stringify(fileURLToPath(new URL("./loop-run.ts", import.meta.url)))};
    const log = await openEventLog(loopPaths(${JSON.stringify(setupResult.home)}, ${JSON.stringify(loopId)}).events);
    await log.append({ type: "owner.started", pid: process.pid, host: hostname() });
    await log.close();
    await runLoop(${JSON.stringify(setupResult.home)}, ${JSON.stringify(loopId)}, {
      cli: ${JSON.stringify(cli)},
      env: process.env,
      afterRunStarted: async () => {
        process.kill(process.pid, "SIGKILL");
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", runner], {
    cwd: setupResult.repo,
    env: setupResult.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childError = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    childError += text;
  });
  const killed = new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (_code, signal) => resolve(signal));
  });
  const pendingRun = await until(async () => {
    const event = (await events(setupResult.home, loopId)).find(
      (item) => item.type === "loop.run_started",
    );
    return event?.type === "loop.run_started" ? event : undefined;
  }, "logged child run");
  assert.equal(await killed, "SIGKILL", childError);
  await assert.rejects(stat(runPaths(setupResult.home, pendingRun.runId).root));

  const resumed = await resume([loopId, "-d"], setupResult.env);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.out, `${loopId}\n`);
  assert.notEqual((await events(setupResult.home, loopId)).at(-1)?.type, "loop.ended");
  const history = await waitForEnd(setupResult.home, loopId);
  const started = history.filter((event) => event.type === "loop.run_started");
  assert.equal(started.length, 1);
  assert.equal(
    started[0]?.type === "loop.run_started" ? started[0].runId : undefined,
    pendingRun.runId,
  );
  assert.deepEqual(started[0]?.type === "loop.run_started" ? started[0].inputSet : undefined, {
    n: "saved",
  });
  assert.equal((await readFile(nextCalls, "utf8")).trim(), "called");
  assert.equal((await readFile(join(root, "recovered-input"), "utf8")).trim(), "saved");
  const created = parseEventLog(
    await readFile(runPaths(setupResult.home, pendingRun.runId).events, "utf8"),
  ).find((event) => event.type === "run.created");
  assert.equal(created?.type === "run.created" ? created.loopIndex : undefined, 1);
});

test("loop resume refuses live, ended, missing and invalid loops with the required codes", async () => {
  const liveSetup = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 1\n",
  );
  const { loopId: liveId } = await startLoop(liveSetup, ["--times", "1", "-d"]);
  const live = await resume([liveId, "-d"], liveSetup.env);
  assert.equal(live.code, 2);
  assert.match(live.err, /code: owner_alive/);

  const endedSetup = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: 'true'\n",
  );
  const { loopId: endedId } = await startLoop(endedSetup, ["--times", "1", "-d"]);
  await waitForEnd(endedSetup.home, endedId);
  const ended = await resume([endedId, "--kill-leftovers"], endedSetup.env);
  assert.equal(ended.code, 2);
  assert.match(ended.err, /code: already_ended/);
  assert.match(ended.err, /help: Resume is only for a crashed loop: start a new loop instead\./);

  const internalId = "loop-20260923-000001-bbbb";
  const internalPaths = loopPaths(endedSetup.home, internalId);
  await mkdir(internalPaths.root, { recursive: true });
  const internalLog = await openEventLog<LoopEvent>(internalPaths.events);
  await internalLog.append({
    type: "loop.created",
    loopId: internalId,
    eventFormatVersion: 1,
    repositoryPath: endedSetup.repo,
    loopfileName: "source",
    source: { kind: "times", count: 1 },
    fixedInputs: {},
    retry: 0,
    maxRuns: null,
    pauseMs: null,
    program: await programIdentity(cli),
  });
  await internalLog.append({ type: "loop.ended", result: "failure", reason: "internal_error" });
  await internalLog.close();
  const internal = await resume([internalId], endedSetup.env);
  assert.equal(internal.code, 2);
  assert.match(internal.err, /code: already_ended/);

  const missing = await resume(["loop-20260923-000003-cccc"], endedSetup.env);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /code: no_such_loop/);

  const bad = await resume(["loop-20260923-000003-cccc", "--force"], endedSetup.env);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /code: bad_argument/);
});
