import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessData } from "../application/status-projection.ts";
import type { RunEvent } from "../domain/events.ts";
import { harnessActivityRouter } from "./harness-activity-router.ts";
import type { StatusWriter } from "./status-writer.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-router-"));
let counter = 0;

function fixture() {
  counter += 1;
  const activityPath = join(scratch, `activity-${counter}.log`);
  const updates: { events: readonly RunEvent[]; data: HarnessData }[] = [];
  const status: StatusWriter = {
    onEvent: async () => undefined,
    onHarnessUpdate: (events, data) => updates.push({ events, data }),
    flush: async () => undefined,
  };
  const events: RunEvent[] = [];
  let tick = 0;
  const nextTick = (): number => {
    tick += 1;
    return tick;
  };
  const route = harnessActivityRouter({
    activityPath,
    attemptId: "001-plan",
    secrets: { attemptSecret: "s3cret", environmentValues: ["/home/me"] },
    status,
    events: () => events,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, nextTick())),
  });
  return { activityPath, updates, route, events };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("a tool call is one filtered log line and moves the activity time", async () => {
  const { activityPath, updates, route, events } = fixture();
  route({ kind: "tool", tool: "edit", target: "/home/me/x.ts" });
  await settle();

  const text = await readFile(activityPath, "utf8");
  assert.match(text, /^\d{2}:\d{2}:\d{2} 001-plan edit \*\*\*\/x\.ts\n$/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.events, events);
  assert.equal(updates[0]?.data.lastActivityAt, "2026-01-01T00:00:01.000Z");
});

test("a long multi-line progress text is cut to one line, without the secret", async () => {
  const { activityPath, updates, route } = fixture();
  route({ kind: "progress", text: `s3cret\n${"x".repeat(500)}` });
  await settle();

  const lines = (await readFile(activityPath, "utf8")).split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1);
  assert.ok(!(lines[0] ?? "").includes("s3cret"));
  assert.ok((lines[0] ?? "").length < 230);
  assert.ok(!(updates[0]?.data.lastProgress ?? "").includes("s3cret"));
});

test("metrics reach the status writer and never the log", async () => {
  const { activityPath, updates, route } = fixture();
  route({
    kind: "metrics",
    metrics: { inputTokens: 3, outputTokens: 0, totalTokens: null, costUsd: null, toolCalls: null },
  });
  await settle();

  await assert.rejects(readFile(activityPath, "utf8"), { code: "ENOENT" });
  assert.equal(updates[0]?.data.metrics.outputTokens, 0);
  assert.equal(updates[0]?.data.metrics.totalTokens, null);
});

test("data accumulates across updates and the activity time advances", async () => {
  const { updates, route } = fixture();
  route({ kind: "progress", text: "working" });
  route({
    kind: "metrics",
    metrics: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.5, toolCalls: 1 },
  });
  await settle();

  assert.equal(updates[1]?.data.lastProgress, "working");
  assert.equal(updates[1]?.data.metrics.costUsd, 0.5);
  assert.equal(updates[1]?.data.lastActivityAt, "2026-01-01T00:00:02.000Z");
});

test("a log line that cannot be written does not throw", async () => {
  const { route } = fixture();
  const bad = harnessActivityRouter({
    activityPath: join(scratch, "no-such-dir", "activity.log"),
    attemptId: "001-plan",
    secrets: {},
    status: {
      onEvent: async () => undefined,
      onHarnessUpdate: () => undefined,
      flush: async () => undefined,
    },
    events: () => [],
  });
  assert.doesNotThrow(() => bad({ kind: "progress", text: "hi" }));
  assert.ok(route);
  await settle();
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
