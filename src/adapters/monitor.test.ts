import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { StatusProjection } from "../domain/status.ts";
import { attachMonitor, type MonitorIo } from "./monitor.ts";
import { runPaths } from "./run-directory.ts";
import { discoverRuns } from "./run-discovery.ts";
import { pingOwner } from "./run-owner.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-monitor-"));
let counter = 0;
const TICK = 20;
const OPTIONS = { pollIntervalMs: TICK, ownerPingTimeoutMs: 200 };
const owners: { close(): Promise<void> }[] = [];
// A failed assertion skips a test's own `owner.close()`; close every owner here so it cannot hang the run.
after(async () => {
  await Promise.all(owners.map((owner) => owner.close().catch(() => undefined)));
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function newRun(): { home: string; runId: string } {
  counter += 1;
  return {
    home: join(scratch, `home-${counter}`),
    runId: `20260918-100000-ab${String.fromCharCode(96 + counter)}c`,
  };
}

async function fakeOwner(socketPath: string, runId: string): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.includes("\n")) socket.write(`${JSON.stringify({ type: "pong", runId })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function terminal(tty = true): {
  io: MonitorIo;
  input: PassThrough;
  raw: boolean[];
  text(): string;
  written(): string;
} {
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    raw: [] as boolean[],
    setRawMode(value: boolean) {
      this.raw.push(value);
    },
  });
  let written = "";
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return {
    io: { input, output },
    input,
    raw: input.raw,
    text: () => stripVTControlCharacters(written),
    written: () => written,
  };
}

function status(runId: string, overrides: Partial<StatusProjection> = {}): StatusProjection {
  return {
    formatVersion: 1,
    seq: 1,
    updatedAt: "2026-09-18T10:00:00.000Z",
    runId,
    loopfileName: "demo",
    loopId: null,
    loopIndex: null,
    state: "running",
    endReason: null,
    startedAt: "2026-09-18T10:00:00.000Z",
    endedAt: null,
    current: null,
    lastActivityAt: "2026-09-18T10:00:00.000Z",
    lastProgress: null,
    visitedSteps: [],
    lastTransition: null,
    transitions: 0,
    maxTransitions: null,
    metrics: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: null,
    },
    ...overrides,
  } as StatusProjection;
}

async function setup(withStatus: boolean, overrides: Partial<StatusProjection> = {}) {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);
  if (withStatus) await writeFile(paths.status, JSON.stringify(status(runId, overrides)));
  const owner = await fakeOwner(paths.socket, runId);
  owners.push(owner);
  return { home, runId, paths, owner, env: { LOOPFILE_HOME: home } };
}

/** The promise's result, or `"pending"` after `ms`. */
async function within(promise: Promise<number>, ms: number): Promise<number | "pending"> {
  return await Promise.race([promise, sleep(ms).then(() => "pending" as const)]);
}

test("no terminal returns 1 and names status and tail", async () => {
  const { runId, env, owner } = await setup(true);
  for (const t of [terminal(false), Object.assign(terminal(), {})]) {
    if (t.io.output.isTTY === true) (t.io.input as { isTTY?: boolean }).isTTY = false;
    const code = await attachMonitor(runId, t.io, env, OPTIONS);
    assert.equal(code, 1);
    assert.match(t.text(), /loopfile status/);
    assert.match(t.text(), /loopfile tail/);
    assert.doesNotMatch(t.text(), /running/);
  }
  await owner.close();
});

test("an unknown run returns 1", async () => {
  const { runId, home } = newRun();
  const t = terminal();
  assert.equal(await attachMonitor(runId, t.io, { LOOPFILE_HOME: home }, OPTIONS), 1);
  assert.match(t.text(), /unknown run/);
});

test("no status.json waits, then shows the live view", async () => {
  const { runId, paths, owner, env } = await setup(false);
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 4);
  assert.match(t.text(), /waiting for run .* to write status.json/);
  await writeFile(paths.status, JSON.stringify(status(runId)));
  await sleep(TICK * 6);
  assert.match(t.text(), /state {5}running/);
  assert.match(t.text(), /d detach · run continues/);
  t.input.write("d");
  assert.equal(await result, 0);
  await owner.close();
});

test("each frame is written with auto-wrap off, so a long line cannot push the redraw down", async () => {
  const { runId, owner, env } = await setup(true, { lastProgress: "x".repeat(500) });
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 3);
  t.input.write("d");
  assert.equal(await within(result, 500), 0);
  const frames = t.written().split("\x1b[?7l").slice(1);
  assert.ok(frames.length > 1);
  for (const frame of frames) assert.ok(frame.includes("d detach · run continues\n\x1b[?7h"));
  await owner.close();
});

test("d detaches, leaves the run active and listed", async () => {
  const { runId, paths, owner, env, home } = await setup(true);
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 3);
  t.input.write("d");
  assert.equal(await within(result, TICK * 2 + 200), 0);
  assert.equal(await pingOwner(paths.socket, 200), runId);
  const entry = (await discoverRuns({ LOOPFILE_HOME: home })).find((e) => e.runId === runId);
  assert.equal(entry?.state, "running");
  await owner.close();
});

test("d detaches when a prompt before the monitor paused the input", async () => {
  const { runId, owner, env } = await setup(true);
  const t = terminal();
  t.input.pause();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 3);
  t.input.write("d");
  assert.equal(await within(result, TICK * 2 + 200), 0);
  await owner.close();
});

test("Ctrl+C detaches", async () => {
  const { runId, owner, env } = await setup(true);
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 3);
  t.input.write("\x03");
  assert.equal(await within(result, TICK * 2 + 200), 0);
  await owner.close();
});

test("q, Ctrl+D, Ctrl+d and EOF do nothing; d still detaches", async () => {
  const { runId, owner, env } = await setup(true);
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 2);
  t.input.write("q");
  t.input.write("\x04");
  t.input.end();
  assert.equal(await within(result, TICK * 5), "pending");
  await owner.close();
  const second = await setup(true);
  const t2 = terminal();
  const result2 = attachMonitor(second.runId, t2.io, second.env, OPTIONS);
  await sleep(TICK * 2);
  t2.input.write("\x1bd");
  assert.equal(await within(result2, TICK * 5), "pending");
  t2.input.write("d");
  assert.equal(await within(result2, 500), 0);
  await second.owner.close();
});

test("status.json ending returns 0 and the last frame is the ended view", async () => {
  const { runId, paths, owner, env } = await setup(true);
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 3);
  const endingStatus = `${paths.status}.tmp`;
  await writeFile(
    endingStatus,
    JSON.stringify(
      status(runId, {
        state: "completed",
        endReason: "success",
        endedAt: "2026-09-18T10:00:09.000Z",
      }),
    ),
  );
  await rename(endingStatus, paths.status);
  assert.equal(await within(result, 500), 0);
  const lastFrame = t.text().slice(t.text().lastIndexOf("run       "));
  assert.match(lastFrame, /state {5}completed \(success\)\n/);
  assert.doesNotMatch(lastFrame, /d detach/);
  await owner.close();
});

test("an owner that closes while status says running shows crashed and returns 2", async () => {
  const { runId, owner, env } = await setup(true);
  await owner.close();
  const t = terminal();
  assert.equal(await attachMonitor(runId, t.io, env, OPTIONS), 2);
  assert.match(t.text(), /crashed · the run owner for .* is gone/);
  assert.deepEqual(t.raw, [true, false]);
});

test("a failed run returns 1", async () => {
  const { runId, owner, env } = await setup(true, {
    state: "failed",
    endReason: "attempt_limit",
    endedAt: "2026-09-18T10:00:09.000Z",
  });
  const t = terminal();
  assert.equal(await attachMonitor(runId, t.io, env, OPTIONS), 1);
  assert.match(t.text(), /failed \(attempt_limit\)/);
  await owner.close();
});

test("an owner that closes after status says completed shows ended", async () => {
  const { runId, owner, env } = await setup(true, {
    state: "completed",
    endReason: "success",
    endedAt: "2026-09-18T10:00:09.000Z",
  });
  await owner.close();
  const t = terminal();
  assert.equal(await attachMonitor(runId, t.io, env, OPTIONS), 0);
  assert.match(t.text(), /completed \(success\)/);
  assert.doesNotMatch(t.text(), /crashed/);
});

test("a run owned by another host shows unknown and skips the ping", async () => {
  const { runId, paths, env, owner } = await setup(true);
  await owner.close();
  await writeFile(
    paths.events,
    `${JSON.stringify({ type: "owner.started", seq: 2, at: "x", host: `${hostname()}-other`, pid: 1 })}\n`,
  );
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 4);
  assert.match(t.text(), /state {5}unknown/);
  assert.doesNotMatch(t.text(), /crashed/);
  t.input.write("d");
  assert.equal(await within(result, 500), 0);
});

test("raw mode is switched off on every return path", async () => {
  const { runId, owner, env } = await setup(true);
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 2);
  t.input.write("d");
  await result;
  assert.deepEqual(t.raw, [true, false]);
  await owner.close();
});

test("a session that detaches writes no run file", async () => {
  const { runId, paths, owner, env } = await setup(true);
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all(
        (await readdir(paths.root)).sort().map(async (name) => {
          const s = await stat(join(paths.root, name));
          return [name, s.size, s.mtimeMs];
        }),
      ),
    );
  const before = await snapshot();
  const t = terminal();
  const result = attachMonitor(runId, t.io, env, OPTIONS);
  await sleep(TICK * 4);
  t.input.write("d");
  await result;
  assert.equal(await snapshot(), before);
  await owner.close();
});

test("a run that ends while the ping waits shows ended, not crashed", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);
  await writeFile(paths.status, JSON.stringify(status(runId)));
  // A socket that accepts and never answers: the ping waits out its timeout.
  const silent: Server = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(paths.socket, () => resolve()));
  owners.push({ close: () => new Promise((resolve) => silent.close(() => resolve())) });

  const t = terminal();
  const result = attachMonitor(runId, t.io, { LOOPFILE_HOME: home }, OPTIONS);
  await sleep(TICK * 2);
  const endingStatus = `${paths.status}.tmp`;
  await writeFile(
    endingStatus,
    JSON.stringify(
      status(runId, {
        state: "completed",
        endReason: "success",
        endedAt: "2026-09-18T10:00:09.000Z",
      }),
    ),
  );
  await rename(endingStatus, paths.status);
  assert.equal(await within(result, 2000), 0);
  assert.match(t.text(), /completed \(success\)/);
  assert.doesNotMatch(t.text(), /crashed/);
});
