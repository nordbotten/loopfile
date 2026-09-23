import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import { modelDigest } from "../application/workflow-run.ts";
import type { RunEvent } from "../domain/events.ts";
import { type LaunchIo, launchCommand } from "./launch-command.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { resumeCommand } from "./resume-command.ts";
import { type RunPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";
import { loadMaterialized } from "./workflow-run.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-resume-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

async function base(): Promise<{ base: string; home: string; env: NodeJS.ProcessEnv }> {
  count += 1;
  const dir = join(root, `case-${count}`);
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  return { base: dir, home, env: { ...process.env, ...gitEnv, LOOPFILE_HOME: home } };
}

function session(tty = false) {
  let out = "";
  let err = "";
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  output.resume();
  const io: LaunchIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    upgrade: { out: () => undefined, err: () => undefined, isTTY: false, ask: async () => null },
    monitor: { input, output } as MonitorIo,
  };
  return { io, out: () => out, err: () => err };
}

async function resume(argv: string[], env: NodeJS.ProcessEnv) {
  const s = session();
  const code = await resumeCommand(["resume", ...argv], cli, s.io, env, { pingTimeoutMs: 200 });
  return { code, out: s.out(), err: s.err() };
}

async function events(paths: RunPaths): Promise<readonly RunEvent[]> {
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

const ended = (paths: RunPaths) =>
  until(
    async () => ((await events(paths)).some((e) => e.type === "run.ended") ? true : undefined),
    "run.ended",
  );

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

test("a run killed during attempt 002 resumes with a new attempt 003 and ends as if it never crashed", async () => {
  const { base: dir, home, env } = await base();
  const repo = join(dir, "repo");
  const mark = join(dir, "second-ran");
  await mkdir(repo);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "first"],
  ]) {
    await run("git", args, { cwd: repo, env });
  }
  const manifest = `formatVersion: 1
steps:
  - id: first
    kind: command
    run: 'true'
  - id: second
    kind: command
    run: 'test -f ${mark} || { touch ${mark}; sleep 30; }'
`;
  const s = session();
  assert.equal(
    await launchCommand(["-", "-d"], cli, s.io, env, {
      repository: repo,
      readStdin: async () => Buffer.from(manifest),
    }),
    0,
  );
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  const second = await until(
    async () =>
      (await events(paths)).find(
        (e) => e.type === "attempt.started" && e.attemptId === "002-second",
      ),
    "attempt 002",
  );
  const group = second.type === "attempt.started" ? second.processGroupId : 0;
  // Under load the shell can start later than attempt.started. Without the
  // mark, attempt 003 would sleep too.
  await until(
    () =>
      stat(mark).then(
        () => true,
        () => undefined,
      ),
    "attempt 002 to touch its mark",
  );
  // `list` reads status.json, which the run owner writes a little after each
  // event. Kill it before that write and the crashed run still shows `first`.
  await until(
    () =>
      readFile(paths.status, "utf8")
        .then((text) => JSON.parse(text))
        .then(
          (status) => (status.current?.stepId === "second" ? true : undefined),
          () => undefined,
        ),
    "status.json to show attempt 002",
  );

  const live = await resume([runId, "-d"], env);
  assert.equal(live.code, 2);
  assert.match(live.err, /^error: a run owner is still running run /);
  assert.match(live.err, /\ncode: owner_alive\n/);

  const owner = (await events(paths)).find((e) => e.type === "owner.started");
  process.kill(owner?.type === "owner.started" ? owner.pid : 0, "SIGKILL");
  await until(
    async () => ((await pingOwner(paths.socket, 200)) === undefined ? true : undefined),
    "the run owner to die",
  );
  assert.ok((await stat(paths.socket)).isSocket(), "a crash leaves the control socket file");

  const listed = await resume([], env);
  assert.equal(listed.code, 0);
  assert.match(listed.out, new RegExp(`${runId}\\s+-\\s+crashed\\s+second`));
  assert.match(listed.out, /Resume one with: loopfile resume <runid>/);

  const logBefore = await readFile(paths.events, "utf8");
  const attemptsBefore = await files(paths.attempts);

  const leftover = await resume([runId, "-d"], env);
  assert.equal(leftover.code, 2);
  assert.match(
    leftover.err,
    new RegExp(`attempt 002-second still has processes in process group ${group}`),
  );
  assert.match(leftover.err, new RegExp(`kill -KILL -- -${group}`));
  assert.match(leftover.err, new RegExp(`loopfile resume ${runId} --kill-leftovers`));
  assert.equal(await readFile(paths.events, "utf8"), logBefore);

  // No -d and no terminal: resume waits for the end and reports it (#184).
  const resumed = await resume([runId, "--kill-leftovers"], env);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.out, `${runId}\n`);
  assert.match(resumed.err, new RegExp(`^resumed: ${runId}\\n`));
  assert.match(resumed.err, new RegExp(`ended: ${runId} completed\\n`));
  await ended(paths);

  const logAfter = await readFile(paths.events, "utf8");
  assert.ok(logAfter.startsWith(logBefore), "earlier events stay byte-identical");
  const all = parseEventLog(logAfter);
  const added = all.slice(parseEventLog(logBefore).length);
  assert.deepEqual(
    added.map((e) => [e.type, "attemptId" in e ? e.attemptId : undefined]),
    [
      ["owner.started", undefined],
      ["attempt.interrupted", "002-second"],
      ["attempt.started", "003-second"],
      ["attempt.ended", "003-second"],
      ["transition", "003-second"],
      ["run.ended", undefined],
    ],
  );
  assert.deepEqual(
    all.flatMap((e) => (e.type === "transition" ? [[e.from, e.to]] : [])),
    [
      ["first", "second"],
      ["second", "$success"],
    ],
  );
  const last = all.at(-1);
  assert.equal(last?.type === "run.ended" && `${last.result} ${last.reason}`, "success end_state");

  const attemptsAfter = await files(paths.attempts);
  for (const [path, bytes] of attemptsBefore) assert.equal(attemptsAfter.get(path), bytes, path);
  await until(async () => {
    try {
      process.kill(-group, 0);
      return undefined;
    } catch {
      return true;
    }
  }, "the leftover group to be gone");
});

test("a run killed during a Ralph iteration refuses resume until the iteration's group is killed", async () => {
  const { base: dir, home, env: baseEnv } = await base();
  const repo = join(dir, "repo");
  const source = join(dir, "source");
  const bin = join(dir, "bin");
  const mark = join(dir, "first-call");
  await mkdir(repo);
  await mkdir(source);
  await mkdir(bin);
  // The fake harness keeps running on its first call and ends at once after that.
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\ncat >/dev/null\ntest -f ${mark} && exit 0\ntouch ${mark}\nexec sleep 30\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const env = { ...baseEnv, PATH: `${bin}:${baseEnv.PATH}` };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "first"],
  ]) {
    await run("git", args, { cwd: repo, env });
  }
  await writeFile(
    join(source, "manifest.yaml"),
    `formatVersion: 1
steps:
  - id: loop
    kind: ralph
    harness: claude
    prompt: Loop.
    maxIterations: 1
    on:
      done: $success
`,
  );
  const s = session();
  assert.equal(await launchCommand([source, "-d"], cli, s.io, env, { repository: repo }), 0);
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  const iteration = await until(
    async () => (await events(paths)).find((e) => e.type === "iteration.started"),
    "iteration 1",
  );
  const group = iteration.type === "iteration.started" ? iteration.processGroupId : 0;
  assert.ok(group > 0, "the iteration records its process group");
  await until(
    () =>
      stat(mark).then(
        () => true,
        () => undefined,
      ),
    "the fake harness to start",
  );

  const owner = (await events(paths)).find((e) => e.type === "owner.started");
  process.kill(owner?.type === "owner.started" ? owner.pid : 0, "SIGKILL");
  await until(
    async () => ((await pingOwner(paths.socket, 200)) === undefined ? true : undefined),
    "the run owner to die",
  );
  const logBefore = await readFile(paths.events, "utf8");

  const leftover = await resume([runId, "-d"], env);
  assert.equal(leftover.code, 2);
  assert.match(
    leftover.err,
    new RegExp(`attempt 001-loop still has processes in process group ${group}`),
  );
  assert.match(leftover.err, /\ncode: operation_failed\n/);
  assert.match(leftover.err, new RegExp(`loopfile resume ${runId} --kill-leftovers`));
  assert.equal(await readFile(paths.events, "utf8"), logBefore);

  const resumed = await resume([runId, "-d", "--kill-leftovers"], env);
  assert.equal(resumed.code, 0, resumed.err);
  await ended(paths);
  const added = parseEventLog(await readFile(paths.events, "utf8")).slice(
    parseEventLog(logBefore).length,
  );
  assert.deepEqual(
    added.slice(0, 3).map((e) => [e.type, "attemptId" in e ? e.attemptId : undefined]),
    [
      ["owner.started", undefined],
      ["attempt.interrupted", "001-loop"],
      ["attempt.started", "002-loop"],
    ],
  );
  await until(async () => {
    try {
      process.kill(-group, 0);
      return undefined;
    } catch {
      return true;
    }
  }, "the leftover group to be gone");
});

/**
 * A crashed run made by hand: a Materialized Loopfile, a workspace folder and
 * a log with `run.created` and `owner.started`. No run owner is started for it.
 */
async function crashedRun(extra: readonly Record<string, unknown>[] = [], digest?: string) {
  const { home, env } = await base();
  const runId = "20260919-120000-abcd";
  const paths = runPaths(home, runId);
  await mkdir(paths.loopfile, { recursive: true });
  await mkdir(paths.workspace);
  await writeFile(
    join(paths.loopfile, "manifest.yaml"),
    "formatVersion: 1\nsteps:\n  - id: only\n    kind: command\n    run: 'true'\n",
  );
  const model = digest ?? modelDigest(await loadMaterialized(paths));
  const at = new Date().toISOString();
  const lines = [
    {
      type: "run.created",
      runId,
      eventFormatVersion: 1,
      modelDigest: model,
      targetFolder: paths.workspace,
      baseCommit: "0".repeat(40),
      branch: `loopfile/${runId}`,
      inputs: [],
    },
    { type: "owner.started", pid: 1, host: hostname() },
    ...extra,
  ].map((event, index) => `${JSON.stringify({ seq: index + 1, at, ...event })}\n`);
  await writeFile(paths.events, lines.join(""));
  return { env, runId, paths };
}

test("resuming after an ended attempt keeps its metrics in status.json", async () => {
  const metrics = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    costUsd: 4,
    toolCalls: 5,
    permissionDenials: null,
  };
  const { env, runId, paths } = await crashedRun([
    {
      type: "attempt.started",
      attemptId: "001-only",
      stepId: "only",
      processGroupId: 0,
    },
    {
      type: "attempt.ended",
      attemptId: "001-only",
      result: "success",
      reason: "clean_exit",
      metrics,
    },
  ]);

  const result = await resume([runId], env);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(await readFile(paths.status, "utf8")).metrics, metrics);
});

test("without -d the monitor attaches to the resumed run until it ends", async () => {
  const { env, runId, paths } = await crashedRun();
  const s = session(true);
  const code = await resumeCommand(["resume", runId], cli, s.io, env, {
    monitor: { pollIntervalMs: 20 },
  });
  assert.equal(code, 0, s.err());
  assert.equal(s.out(), `${runId}\n`);
  assert.equal(s.err(), `resumed: ${runId}\n`);
  await ended(paths);
  const types = (await events(paths)).map((e) => e.type);
  assert.deepEqual(types.slice(2, 4), ["owner.started", "attempt.started"]);
  assert.equal(types.at(-1), "run.ended");
});

test("a changed Materialized Loopfile stops resume with both digests shown", async () => {
  const { env, runId, paths } = await crashedRun([], "sha256-of-another-model");
  const now = modelDigest(await loadMaterialized(paths));
  const result = await resume([runId], env);
  assert.equal(result.code, 2);
  assert.match(result.err, /run.created model digest: sha256-of-another-model/);
  assert.match(result.err, /\ncode: format_mismatch\n/);
  assert.match(result.err, new RegExp(`model digest now: +${now}`));
});

test("a broken middle line in events.jsonl stops resume", async () => {
  const { env, runId, paths } = await crashedRun();
  const text = await readFile(paths.events, "utf8");
  const [first, ...rest] = text.split("\n");
  await writeFile(paths.events, [first, "{not json", ...rest].join("\n"));
  const result = await resume([runId], env);
  assert.equal(result.code, 2);
  assert.match(result.err, /events\.jsonl line 2 is not a readable event/);
  assert.match(result.err, /\ncode: log_corrupt\n/);
});

test("an ended or cancelled run is refused with its state", async () => {
  const done = await crashedRun([{ type: "run.ended", result: "success", reason: "end_state" }]);
  const endedRun = await resume([done.runId], done.env);
  assert.equal(endedRun.code, 1);
  assert.match(endedRun.err, /completed\. Resume is only for a crashed run/);
  assert.match(endedRun.err, /Completed runs cannot be continued/);

  const stopped = await crashedRun([{ type: "run.cancelled" }]);
  const cancelled = await resume([stopped.runId], stopped.env);
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.err, /was cancelled\. Continue it with `loopfile continue/);
});

test("a run whose workspace is gone is refused, and resume never makes a new one", async () => {
  const { env, runId, paths } = await crashedRun();
  await rm(paths.workspace, { recursive: true });
  const result = await resume([runId], env);
  assert.equal(result.code, 2);
  assert.match(result.err, /the workspace of run .* is gone/);
  assert.match(result.err, /\ncode: workspace_missing\n/);
});

test("an unknown run, bad arguments and an empty home", async () => {
  const { env } = await base();
  const missing = await resume(["20260101-000000-zzzz"], env);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no run 20260101-000000-zzzz/);
  assert.match(missing.err, /\ncode: no_such_run\n/);

  for (const argv of [["a", "b"], ["--nope"]]) {
    const bad = await resume(argv, env);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /Usage: loopfile resume <runid>/);
  }

  assert.deepEqual(await resume([], env), { code: 0, out: "no crashed runs\n", err: "" });
});
