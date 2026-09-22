import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseStatusProjection } from "../application/status.ts";
import type { RunEvent } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import { LIVE_UPDATE_INTERVAL_MS, openStatusWriter } from "./status-writer.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-status-"));
let counter = 0;

function newPath(): string {
  counter += 1;
  return join(scratch, `status-${counter}.json`);
}

const workflow: Workflow = {
  formatVersion: 1,
  inputs: {},
  steps: [
    {
      id: "plan",
      kind: "agent",
      harness: "claude",
      promptFile: "plan.md",
      args: [],
      on: { ready: "$success" },
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 5,
      timeoutMs: 3_600_000,
    },
  ],
};

function at(second: number): string {
  return new Date(Date.UTC(2026, 8, 18, 10, 0, second)).toISOString();
}

/** One event as a test writes it: everything but `seq`, which `log` numbers in order. */
type EventWithoutSeq = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "seq">
    : never
  : never;

function log(...partials: readonly EventWithoutSeq[]): RunEvent[] {
  return partials.map((event, index) => ({ ...event, seq: index + 1 }) as RunEvent);
}

const created: EventWithoutSeq = {
  type: "run.created",
  at: at(0),
  runId: "r-1",
  eventFormatVersion: 1,
  modelDigest: "sha256:model",
  repositoryPath: "/home/me/project",
  baseCommit: "9f1c0de",
  branch: "loopfile/r-1",
  inputs: [],
};

async function readStatus(path: string) {
  return parseStatusProjection(JSON.parse(await readFile(path, "utf8")));
}

test("opening a writer writes status.json at once, fresh from the given events", async () => {
  const path = newPath();
  await openStatusWriter({ path, workflow, loopfileName: "implement", events: log(created) });

  const status = await readStatus(path);
  assert.equal(status.runId, "r-1");
  assert.equal(status.state, "running");
  assert.deepEqual(status.metrics, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    toolCalls: null,
    permissionDenials: null,
  });
});

test("onEvent writes the file again with the new seq, never delayed", async () => {
  const path = newPath();
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
  });

  await writer.onEvent(log(created, { type: "owner.started", at: at(1), pid: 1, host: "box" }));

  const status = await readStatus(path);
  assert.equal(status.seq, 2);
});

test("delete status.json, restart from events.jsonl, and it comes back with the same content", async () => {
  const path = newPath();
  const events = log(
    created,
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "001-plan",
      stepId: "plan",
      processGroupId: 1,
    },
    {
      type: "attempt.ended",
      at: at(2),
      attemptId: "001-plan",
      result: "success",
      reason: "outcome",
      outcome: "ready",
    },
    { type: "run.ended", at: at(3), result: "success", reason: "end_state" },
  );
  const now = () => Date.UTC(2026, 8, 18, 10, 5, 0);

  const first = await openStatusWriter({ path, workflow, loopfileName: "implement", events, now });
  const before = await readStatus(path);
  void first;

  // Simulate "delete status.json, restart the writer" (ADR 0007 acceptance criterion): a
  // fresh writer with the same events and the same clock reproduces the same file.
  const restarted = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events,
    now,
  });
  void restarted;
  const after = await readStatus(path);

  assert.deepEqual(after, before);
});

test("a tight read loop during many writes never sees a partial or invalid file", async () => {
  const path = newPath();
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
  });

  let stop = false;
  let reads = 0;
  const reader = (async () => {
    while (!stop) {
      const text = await readFile(path, "utf8").catch(() => "");
      if (text !== "") {
        assert.doesNotThrow(() => parseStatusProjection(JSON.parse(text)));
        reads += 1;
      }
    }
  })();

  for (let i = 0; i < 200; i++) {
    await writer.onEvent(log(created, { type: "owner.started", at: at(1), pid: i, host: "box" }));
  }
  stop = true;
  await reader;

  assert.ok(reads > 0);
});

test("many harness updates within a second give at most about one write, and the last value lands", async () => {
  const path = newPath();
  let now = Date.UTC(2026, 8, 18, 10, 0, 0);
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
    now: () => now,
  });

  const events = log(created);
  for (let i = 1; i <= 10; i++) {
    writer.onHarnessUpdate(events, {
      lastActivityAt: at(i),
      lastProgress: `progress ${i}`,
      metrics: {
        inputTokens: i,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        toolCalls: null,
        permissionDenials: null,
      },
    });
  }
  const afterBurst = await readStatus(path);
  // The opening write plus at most one more from the burst, since no real time passed.
  assert.equal(afterBurst.lastProgress, null);

  now += LIVE_UPDATE_INTERVAL_MS;
  await writer.flush();

  const afterFlush = await readStatus(path);
  assert.equal(afterFlush.lastProgress, "progress 10");
  assert.equal(afterFlush.metrics.inputTokens, 10);
});

test("a harness update after the rate limit window writes at once", async () => {
  const path = newPath();
  let now = Date.UTC(2026, 8, 18, 10, 0, 0);
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
    now: () => now,
  });

  now += LIVE_UPDATE_INTERVAL_MS + 1;
  writer.onHarnessUpdate(log(created), {
    lastActivityAt: at(2),
    lastProgress: "edit src/x.ts",
    metrics: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: null,
    },
  });
  await writer.flush();

  const status = await readStatus(path);
  assert.equal(status.lastProgress, "edit src/x.ts");
});

test("an ended run keeps a final status.json with the final state", async () => {
  const path = newPath();
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
  });

  await writer.onEvent(
    log(created, { type: "run.ended", at: at(5), result: "success", reason: "end_state" }),
  );

  const status = await readStatus(path);
  assert.equal(status.state, "completed");
  assert.equal(status.endReason, "success");
  assert.equal(status.current, null);
});

test("a harness update inside the rate-limit window, then run.ended: the scheduled write shows the final state, not the stale one", async () => {
  const path = newPath();
  let now = Date.UTC(2026, 8, 18, 10, 0, 0);
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
    now: () => now,
  });

  // Schedules a write for later: no real time has passed since the opening write.
  writer.onHarnessUpdate(log(created), {
    lastActivityAt: at(1),
    lastProgress: "still going",
    metrics: {
      inputTokens: 1,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: null,
    },
  });

  const ended = log(created, {
    type: "run.ended",
    at: at(2),
    result: "success",
    reason: "end_state",
  });
  await writer.onEvent(ended);

  // The event write already shows the final state before the scheduled one ever fires.
  const afterEvent = await readStatus(path);
  assert.equal(afterEvent.state, "completed");
  assert.equal(afterEvent.seq, ended.at(-1)?.seq);

  // Whether it fires as a real timer or is drained by flush, the pending write must
  // still show the final state and the latest seq, never the running snapshot it was
  // scheduled from.
  now += LIVE_UPDATE_INTERVAL_MS;
  await writer.flush();

  const afterFlush = await readStatus(path);
  assert.equal(afterFlush.state, "completed");
  assert.equal(afterFlush.endReason, "success");
  assert.equal(afterFlush.seq, ended.at(-1)?.seq);
  assert.equal(afterFlush.current, null);
});

test("seq matches the last event's own seq after every event that changes the view", async () => {
  const path = newPath();
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
  });

  const steps: readonly EventWithoutSeq[] = [
    // run start
    created,
    // attempt start
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "001-plan",
      stepId: "plan",
      processGroupId: 1,
    },
    // data put
    {
      type: "data.put",
      at: at(1),
      attemptId: "001-plan",
      key: "plan.notes",
      size: 4,
      digest: "sha256:x",
    },
    // outcome
    { type: "outcome.reported", at: at(2), attemptId: "001-plan", outcome: "ready" },
    // attempt end
    {
      type: "attempt.ended",
      at: at(2),
      attemptId: "001-plan",
      result: "success",
      reason: "outcome",
      outcome: "ready",
    },
    // transition
    {
      type: "transition",
      at: at(2),
      from: "plan",
      attemptId: "001-plan",
      result: "success",
      reason: "outcome",
      outcome: "ready",
      to: "$success",
      cause: "on",
    },
    // run end
    { type: "run.ended", at: at(3), result: "success", reason: "end_state" },
  ];

  let events: RunEvent[] = [];
  for (const step of steps) {
    events = [...events, { ...step, seq: events.length + 1 } as RunEvent];
    await writer.onEvent(events);
    const status = await readStatus(path);
    assert.equal(status.seq, events.at(-1)?.seq, `after ${step.type}`);
  }
});

test("no reader process writes the file: reading it in a loop never changes what a later read sees", async () => {
  const path = newPath();
  const writer = await openStatusWriter({
    path,
    workflow,
    loopfileName: "implement",
    events: log(created),
  });
  await writer.onEvent(log(created, { type: "owner.started", at: at(1), pid: 1, host: "box" }));
  const expected = await readFile(path, "utf8");

  // Many concurrent readers, none of which ever calls a writer method. If any of them
  // wrote to the file, a later read here would see something other than `expected`.
  const reads = await Promise.all(Array.from({ length: 50 }, () => readFile(path, "utf8")));

  for (const text of reads) assert.equal(text, expected);
  assert.equal(await readFile(path, "utf8"), expected);
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
