import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loopStatus } from "../application/loop-status.ts";
import { buildLoopStatusView, renderLoopStatusView } from "../application/loop-status-view.ts";
import { UNKNOWN_METRICS } from "../application/status-projection.ts";
import type { LoopEvent } from "../domain/events.ts";
import type { LoopStatus } from "../domain/status.ts";
import { loopPaths, runPaths } from "./run-directory.ts";
import { statusCommand } from "./status-command.ts";

const homes: string[] = [];
after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

function runner() {
  let output = "";
  let errors = "";
  return {
    out: (text: string) => {
      output += text;
    },
    err: (text: string) => {
      errors += text;
    },
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}

async function fakeOwner(socketPath: string, ownerId: string): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.includes("\n")) {
        socket.write(`${JSON.stringify({ type: "pong", runId: ownerId })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function makeLoop(
  runCount: number,
  loopId = `loop-20260922-120000-${String(runCount).padStart(4, "a")}`,
) {
  const home = await mkdtemp(join(tmpdir(), "loopfile-loop-status-"));
  homes.push(home);
  const source = { kind: "times" as const, count: runCount };
  const created = {
    seq: 1,
    at: "2026-09-22T12:00:00.000Z",
    type: "loop.created" as const,
    loopId,
    eventFormatVersion: 1 as const,
    repositoryPath: "/repo",
    loopfileName: "review.loop",
    source,
    fixedInputs: { project: "loopfile" },
    retry: 1,
    maxRuns: runCount,
    pauseMs: null,
    program: { version: "0.1.0", digest: "sha256:program" },
  };
  const events: LoopEvent[] = [created];
  const runIds: string[] = [];
  for (let index = 1; index <= runCount; index += 1) {
    const runId = `20260922-1200${String(index).padStart(2, "0")}-aaaa`;
    runIds.push(runId);
    events.push({
      seq: index + 1,
      at: `2026-09-22T12:00:${String(index).padStart(2, "0")}.000Z`,
      type: "loop.run_started",
      runId,
      index,
      inputSet: {
        project: "loopfile",
        issue: index === 1 ? "1234567890123456789012345" : `issue-${index}`,
      },
      sourceIndex: index,
      retryOf: index === 2 ? (runIds[0] ?? null) : null,
    });
  }
  events.push({
    seq: runCount + 2,
    at: "2026-09-22T12:30:00.000Z",
    type: "loop.ended",
    result: "success",
    reason: "max_runs",
  });

  const loop = loopPaths(home, loopId);
  await mkdir(loop.root, { recursive: true });
  await writeFile(loop.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(loop.status, `${JSON.stringify(loopStatus(events))}\n`);
  for (const [index, runId] of runIds.entries()) {
    const run = runPaths(home, runId);
    await mkdir(run.root, { recursive: true });
    await writeFile(
      run.status,
      JSON.stringify(
        childStatus(
          runId,
          loopId,
          index + 1,
          `2026-09-22T12:00:${String(index + 5).padStart(2, "0")}.000Z`,
        ),
      ),
    );
  }
  return { home, loopId };
}

function childStatus(runId: string, loopId: string, loopIndex: number, endedAt: string) {
  return {
    formatVersion: 1,
    seq: 3,
    updatedAt: endedAt,
    runId,
    loopfileName: "review.loop",
    loopId,
    loopIndex,
    state: "completed",
    endReason: "success",
    startedAt: "2026-09-22T12:00:00.000Z",
    endedAt,
    current: null,
    lastActivityAt: endedAt,
    lastProgress: null,
    visitedSteps: [{ stepId: "work", attempts: 1 }],
    lastTransition: null,
    transitions: 1,
    maxTransitions: null,
    metrics: { ...UNKNOWN_METRICS, costUsd: 1.5 },
  };
}

function statusOf(events: LoopEvent[]): LoopStatus {
  return loopStatus(events);
}

test("status prints a loop's facts and three newest-last child rows, and JSON has all three", async () => {
  const { home, loopId } = await makeLoop(3);
  const text = runner();
  const code = await statusCommand(["status", loopId], text.out, text.err, { LOOPFILE_HOME: home });
  assert.equal(code, 0);
  assert.equal(text.errors, "");
  assert.deepEqual(text.output.split("\n").slice(0, 6), [
    `loop: ${loopId}`,
    "state: completed",
    "loopfile: review.loop",
    "source: times 3",
    "place: 3 of 3",
    "runs: 3 (1 retries)",
  ]);
  const table = text.output.slice(text.output.indexOf("\n\n") + 2);
  assert.match(table, /^#\s+RUN ID\s+INPUT SET\s+STATE\s+TIME\s+COST/);
  assert.equal(table.trim().split("\n").length, 5);
  assert.match(table, /issue=12345678901234567890/);
  assert.doesNotMatch(table, /1234567890123456789012345/);
  assert.match(table, /est\. \$1\.50/);
  assert.match(
    text.output,
    /^totals: 3 completed, 1 retries, wall 30:00, est\. \$4\.50, mean 0:06 \/ est\. \$1\.50 per completed run$/m,
  );

  const json = runner();
  assert.equal(
    await statusCommand(["status", loopId, "--json"], json.out, json.err, { LOOPFILE_HOME: home }),
    0,
  );
  const parsed = JSON.parse(json.output);
  assert.equal(parsed.loop.state, "completed");
  assert.equal(parsed.runs.length, 3);
  assert.equal(parsed.runs[1].retryOf, parsed.runs[0].runId);
  assert.equal(parsed.runs[0].metrics.costUsd, 1.5);
  assert.deepEqual(parsed.totals, {
    completed: 3,
    failed: 0,
    cancelled: 0,
    retries: 1,
    wallMs: 1_800_000,
    costUsd: 4.5,
    runsWithoutCost: 0,
    meanMsPerCompleted: 6_000,
    meanCostUsdPerCompleted: 1.5,
  });
});

test("status shows only ten text rows but all twelve JSON runs", async () => {
  const { home, loopId } = await makeLoop(12, "loop-20260922-120001-bbbb");
  const text = runner();
  await statusCommand(["status", loopId], text.out, text.err, { LOOPFILE_HOME: home });
  const table = text.output.slice(text.output.indexOf("\n\n") + 2);
  assert.equal(table.trim().split("\n").length, 12);

  const json = runner();
  await statusCommand(["status", loopId, "--json"], json.out, json.err, { LOOPFILE_HOME: home });
  assert.equal(JSON.parse(json.output).runs.length, 12);
});

test("status shows the next run while a loop is paused", async () => {
  const home = await mkdtemp(join(tmpdir(), "loopfile-loop-status-paused-"));
  homes.push(home);
  const loopId = "loop-20260922-120002-cccc";
  const events: LoopEvent[] = [
    {
      seq: 1,
      at: "2026-09-22T12:00:00.000Z",
      type: "loop.created",
      loopId,
      eventFormatVersion: 1,
      repositoryPath: "/repo",
      loopfileName: "review.loop",
      source: { kind: "next", command: "next-input" },
      fixedInputs: {},
      retry: 0,
      maxRuns: null,
      pauseMs: null,
      program: { version: "0.1.0", digest: "sha256:program" },
    },
    {
      seq: 2,
      at: "2026-09-22T12:01:00.000Z",
      type: "loop.paused",
      until: "2026-09-22T12:02:00.000Z",
    },
  ];
  const paths = loopPaths(home, loopId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(paths.status, JSON.stringify(statusOf(events)));
  const r = runner();
  await statusCommand(
    ["status", loopId],
    r.out,
    r.err,
    { LOOPFILE_HOME: home },
    { pingTimeoutMs: 5 },
  );
  assert.match(r.output, /^source: next next-input$/m);
  assert.match(r.output, /^next run: 2026-09-22T12:02:00.000Z$/m);
  assert.doesNotMatch(r.output, /^place:/m);
});

test("status shows a cancelled loop's mode and detail", async () => {
  const home = await mkdtemp(join(tmpdir(), "loopfile-loop-status-cancelled-"));
  homes.push(home);
  const loopId = "loop-20260922-120003-dddd";
  const created: LoopEvent = {
    seq: 1,
    at: "2026-09-22T12:00:00.000Z",
    type: "loop.created",
    loopId,
    eventFormatVersion: 1,
    repositoryPath: "/repo",
    loopfileName: "review.loop",
    source: { kind: "times", count: 2 },
    fixedInputs: {},
    retry: 0,
    maxRuns: null,
    pauseMs: null,
    program: { version: "0.1.0", digest: "sha256:program" },
  };
  const events: LoopEvent[] = [
    created,
    {
      seq: 2,
      at: "2026-09-22T12:01:00.000Z",
      type: "loop.ended",
      result: "failure",
      reason: "cancelled",
      cancelMode: "after_run",
      detail: "operator stopped",
    },
  ];
  const paths = loopPaths(home, loopId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(paths.status, JSON.stringify(statusOf(events)));
  const r = runner();
  await statusCommand(["status", loopId], r.out, r.err, { LOOPFILE_HOME: home });
  assert.match(r.output, /^ended: cancelled \(after_run\) - operator stopped$/m);
});

test("status reports a missing loop with no_such_loop", async () => {
  const r = runner();
  const home = await mkdtemp(join(tmpdir(), "loopfile-loop-status-missing-"));
  homes.push(home);
  const code = await statusCommand(["status", "loop-20260922-120004-eeee"], r.out, r.err, {
    LOOPFILE_HOME: home,
  });
  assert.equal(code, 2);
  assert.match(r.errors, /\ncode: no_such_loop\n/);
});

test("status gets the current child step from a live child owner", async () => {
  const { home, loopId } = await makeLoop(1, "loop-20260922-120005-ffff");
  const runId = "20260922-120001-aaaa";
  const loop = loopPaths(home, loopId);
  const child = runPaths(home, runId);
  const loopProjection = JSON.parse(await readFile(loop.status, "utf8")) as LoopStatus;
  await writeFile(
    loop.status,
    JSON.stringify({
      ...loopProjection,
      state: "running",
      currentRunId: runId,
      endReason: null,
      endedAt: null,
    }),
  );
  await writeFile(
    child.status,
    JSON.stringify({
      ...childStatus(runId, loopId, 1, "2026-09-22T12:00:05.000Z"),
      state: "running",
      endReason: null,
      endedAt: null,
      current: {
        stepId: "work",
        stepKind: "command",
        attemptId: "001-work",
        attempt: 1,
        maxAttempts: 1,
        iteration: null,
        maxIterations: null,
        harness: null,
        startedAt: "2026-09-22T12:00:00.000Z",
      },
    }),
  );
  await writeFile(
    child.events,
    `${[
      {
        seq: 1,
        at: "2026-09-22T12:00:00.000Z",
        type: "run.created",
        runId,
        eventFormatVersion: 1,
        modelDigest: "sha256:program",
        repositoryPath: "/repo",
        baseCommit: "0".repeat(40),
        branch: `loopfile/${runId}`,
        inputs: [],
      },
      { seq: 2, at: "2026-09-22T12:00:00.000Z", type: "owner.started", pid: 1, host: hostname() },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );
  const loopOwner = await fakeOwner(loop.socket, loopId);
  const childOwner = await fakeOwner(child.socket, runId);
  try {
    const text = runner();
    assert.equal(
      await statusCommand(
        ["status", loopId],
        text.out,
        text.err,
        { LOOPFILE_HOME: home },
        {
          pingTimeoutMs: 100,
        },
      ),
      0,
    );
    assert.match(text.output, new RegExp(`^current: ${runId} at step work$`, "m"));
  } finally {
    await childOwner.close();
    await loopOwner.close();
  }
});

test("loop status rendering includes the current child step", () => {
  const loopId = "loop-20260922-120005-ffff";
  const status = statusOf([
    {
      seq: 1,
      at: "2026-09-22T12:00:00.000Z",
      type: "loop.created",
      loopId,
      eventFormatVersion: 1,
      repositoryPath: "/repo",
      loopfileName: "review.loop",
      source: { kind: "times", count: 1 },
      fixedInputs: {},
      retry: 0,
      maxRuns: null,
      pauseMs: null,
      program: { version: "0.1.0", digest: "sha256:program" },
    },
  ]);
  const view = buildLoopStatusView(
    status,
    "running",
    [
      {
        index: 1,
        runId: "20260922-120000-aaaa",
        inputSet: {},
        retryOf: null,
        state: "running",
        elapsedMs: 1,
        metrics: UNKNOWN_METRICS,
      },
    ],
    "2026-09-22T12:00:00.000Z",
  );
  assert.match(
    renderLoopStatusView(
      { ...view, loop: { ...view.loop, currentRunId: "20260922-120000-aaaa" } },
      "work",
    ),
    /^current: 20260922-120000-aaaa at step work$/m,
  );
});
