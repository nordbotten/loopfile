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
import type { LoopEvent } from "../domain/events.ts";
import { materializeDirectory } from "./directory-loader.ts";
import { openEventLog } from "./event-log.ts";
import { loopCommand } from "./loop-command.ts";
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
