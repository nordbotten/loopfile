import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UNKNOWN_METRICS } from "../application/status-projection.ts";
import { STATUS_FORMAT_VERSION } from "../domain/status.ts";
import { runPaths } from "./run-directory.ts";
import { discoverRuns } from "./run-discovery.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-run-discovery-"));
let counter = 0;

/** A fresh home and run ID, with nothing on disk yet. */
function newHome(): { home: string } {
  counter += 1;
  return { home: join(scratch, `home-${counter}`) };
}

/** Consecutive, valid run IDs a few minutes apart, oldest first. */
function runId(minutesPastMidnight: number, tail = "aaaa"): string {
  const hh = String(Math.floor(minutesPastMidnight / 60)).padStart(2, "0");
  const mm = String(minutesPastMidnight % 60).padStart(2, "0");
  return `20260917-${hh}${mm}00-${tail}`;
}

/** A minimal but complete v1 `status.json` body, overridable per test. */
function statusBody(
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    formatVersion: STATUS_FORMAT_VERSION,
    seq: 1,
    updatedAt: "2026-09-17T16:04:00.000Z",
    runId,
    loopfileName: "review-loop",
    state: "running",
    endReason: null,
    startedAt: "2026-09-17T16:03:00.000Z",
    endedAt: null,
    current: null,
    lastActivityAt: "2026-09-17T16:04:00.000Z",
    lastProgress: null,
    visitedSteps: [],
    lastTransition: null,
    transitions: 0,
    maxTransitions: null,
    metrics: UNKNOWN_METRICS,
    ...overrides,
  };
}

async function writeEvents(path: string, host: string): Promise<void> {
  const created = { type: "run.created", seq: 1, at: "2026-09-17T16:03:00.000Z", runId: "r" };
  const started = { type: "owner.started", seq: 2, at: "2026-09-17T16:03:00.000Z", pid: 1, host };
  await writeFile(path, `${JSON.stringify(created)}\n${JSON.stringify(started)}\n`);
}

/** A fake control socket that answers a ping with `runId`. */
async function fakeOwner(
  socketPath: string,
  answerRunId: string,
): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.includes("\n")) {
        socket.write(`${JSON.stringify({ type: "pong", runId: answerRunId })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("no runs folder gives an empty list, not an error", async () => {
  const { home } = newHome();
  assert.deepEqual(await discoverRuns({ LOOPFILE_HOME: home }), []);
});

test("an ended run needs no socket and shows its own state", async () => {
  const { home } = newHome();
  const id = runId(60);
  const paths = runPaths(home, id);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.status,
    JSON.stringify(
      statusBody(id, {
        state: "completed",
        endReason: "success",
        endedAt: "2026-09-17T16:05:00.000Z",
      }),
    ),
  );

  const [entry] = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 100 });
  assert.equal(entry?.runId, id);
  assert.equal(entry?.state, "completed");
  assert.equal(entry?.loopfileName, "review-loop");
});

test("a running run whose owner answers on this host is running", async () => {
  const { home } = newHome();
  const id = runId(61);
  const paths = runPaths(home, id);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, JSON.stringify(statusBody(id)));
  await writeEvents(paths.events, hostname());
  const owner = await fakeOwner(paths.socket, id);

  try {
    const [entry] = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 500 });
    assert.equal(entry?.state, "running");
  } finally {
    await owner.close();
  }
});

test("a running run with no answering socket is crashed", async () => {
  const { home } = newHome();
  const id = runId(62);
  const paths = runPaths(home, id);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, JSON.stringify(statusBody(id)));
  await writeEvents(paths.events, hostname());

  const [entry] = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 100 });
  assert.equal(entry?.state, "crashed");
});

test("a running run whose owner started on another host is unknown", async () => {
  const { home } = newHome();
  const id = runId(63);
  const paths = runPaths(home, id);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, JSON.stringify(statusBody(id)));
  await writeEvents(paths.events, "some-other-host");

  const [entry] = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 100 });
  assert.equal(entry?.state, "unknown");
});

test("a run folder with no status.json still gets a row, and discovery still succeeds", async () => {
  const { home } = newHome();
  const id = runId(64);
  await mkdir(runPaths(home, id).root, { recursive: true });

  const entries = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.runId, id);
  assert.equal(entries[0]?.state, "unreadable");
});

test("a run folder with a broken status.json still gets a row", async () => {
  const { home } = newHome();
  const id = runId(65);
  const paths = runPaths(home, id);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, "{ not json");

  const entries = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 100 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.state, "unreadable");
});

test("a folder under runs/ that is not a run ID is ignored", async () => {
  const { home } = newHome();
  await mkdir(join(home, "runs", "not-a-run-id"), { recursive: true });

  assert.deepEqual(await discoverRuns({ LOOPFILE_HOME: home }), []);
});

test("multiple runs come back active-first, newest first within each group", async () => {
  const { home } = newHome();
  const older = runId(10, "aaaa");
  const newer = runId(20, "bbbb");
  await mkdir(runPaths(home, older).root, { recursive: true });
  await mkdir(runPaths(home, newer).root, { recursive: true });
  await writeFile(
    runPaths(home, older).status,
    JSON.stringify(
      statusBody(older, {
        state: "failed",
        endReason: "failure",
        startedAt: "2026-09-17T00:10:00.000Z",
        endedAt: "2026-09-17T00:15:00.000Z",
      }),
    ),
  );
  await writeFile(
    runPaths(home, newer).status,
    JSON.stringify(
      statusBody(newer, {
        state: "failed",
        endReason: "failure",
        startedAt: "2026-09-17T00:20:00.000Z",
        endedAt: "2026-09-17T00:25:00.000Z",
      }),
    ),
  );

  const entries = await discoverRuns({ LOOPFILE_HOME: home }, { pingTimeoutMs: 100 });
  assert.deepEqual(
    entries.map((entry) => entry.runId),
    [newer, older],
  );
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
