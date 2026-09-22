import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LOOP_STATUS_FORMAT_VERSION } from "../domain/status.ts";
import { discoverLoops } from "./loop-discovery.ts";
import { loopPaths } from "./run-directory.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-loop-discovery-"));
let counter = 0;

function home(): string {
  counter += 1;
  return join(scratch, `home-${counter}`);
}

function loopId(minutes: number): string {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `loop-20260917-${hour}${minute}00-abcd`;
}

function statusBody(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: LOOP_STATUS_FORMAT_VERSION,
    seq: 1,
    loopId: id,
    loopfileName: "review-loop",
    state: "running",
    source: { kind: "times", count: 2 },
    fixedInputs: {},
    retry: 0,
    maxRuns: null,
    place: 0,
    runs: 0,
    retries: 0,
    lastInputSet: null,
    lastSourceIndex: null,
    lastRetryCount: 0,
    runIds: [],
    currentRunId: null,
    pausedUntil: null,
    cancelRequested: null,
    endReason: null,
    cancelMode: null,
    detail: null,
    startedAt: "2026-09-17T16:03:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

async function writeLoop(
  root: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const paths = loopPaths(root, id);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, JSON.stringify(statusBody(id, overrides)));
}

async function fakeOwner(socketPath: string, id: string): Promise<Server> {
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\n")) socket.write(`${JSON.stringify({ type: "pong", runId: id })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

async function closeOwner(owner: Server): Promise<void> {
  if (!owner.listening) return;
  await new Promise<void>((resolve) => owner.close(() => resolve()));
}

test("no loops folder gives an empty list", async () => {
  assert.deepEqual(await discoverLoops({ LOOPFILE_HOME: home() }), []);
});

test("a running loop becomes crashed when its owner is killed", async () => {
  const root = home();
  const id = loopId(1);
  await writeLoop(root, id);
  const owner = await fakeOwner(loopPaths(root, id).socket, id);
  try {
    const [running] = await discoverLoops({ LOOPFILE_HOME: root }, { pingTimeoutMs: 100 });
    assert.equal(running?.state, "running");
    await closeOwner(owner);
    const [crashed] = await discoverLoops({ LOOPFILE_HOME: root }, { pingTimeoutMs: 20 });
    assert.equal(crashed?.state, "crashed");
  } finally {
    await closeOwner(owner);
  }
});

test("ended loops keep their state and do not need an owner", async () => {
  const root = home();
  const id = loopId(3);
  await writeLoop(root, id, {
    state: "completed",
    runs: 2,
    endedAt: "2026-09-17T16:04:00.000Z",
    endReason: "max_runs",
  });
  const [entry] = await discoverLoops(
    { LOOPFILE_HOME: root },
    { now: () => new Date("2026-09-17T16:05:00.000Z"), pingTimeoutMs: 20 },
  );
  assert.equal(entry?.state, "completed");
  assert.equal(entry?.runs, 2);
  assert.equal(entry?.elapsedMs, 60_000);
});

test("unrelated folders under loops are ignored", async () => {
  const root = home();
  await mkdir(join(root, "loops", "not-a-loop"), { recursive: true });
  assert.deepEqual(await discoverLoops({ LOOPFILE_HOME: root }), []);
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
