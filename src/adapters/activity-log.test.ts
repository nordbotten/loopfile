import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import { appendActivity, withActivityHook } from "./activity-log.ts";
import type { EventLog, NewEvent } from "./event-log.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-activity-"));
let counter = 0;

function newPath(): string {
  counter += 1;
  return join(scratch, `activity-${counter}.log`);
}

test("appendActivity writes one filtered, timestamped line and creates the file", async () => {
  const path = newPath();
  await appendActivity(path, "001-implement", "step started");

  const contents = await readFile(path, "utf8");
  assert.match(contents, /^\d{2}:\d{2}:\d{2} 001-implement step started\n$/);
});

test("appendActivity appends rather than overwriting an earlier line", async () => {
  const path = newPath();
  await appendActivity(path, "001-implement", "step started");
  await appendActivity(path, "001-implement", "outcome complete");

  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /step started$/);
  assert.match(lines[1] ?? "", /outcome complete$/);
});

test("appendActivity writes with no attempt ID when there is none", async () => {
  const path = newPath();
  await appendActivity(path, null, "run cancelled");

  const contents = await readFile(path, "utf8");
  assert.match(contents, /^\d{2}:\d{2}:\d{2} run cancelled\n$/);
});

test("appendActivity keeps the 200-character cut and secret mask", async () => {
  const path = newPath();
  await appendActivity(path, "001-implement", `secret ${"x".repeat(250)}`, {
    attemptSecret: "secret",
  });

  const contents = await readFile(path, "utf8");
  const message = contents.replace(/^\d{2}:\d{2}:\d{2} 001-implement /, "").trimEnd();
  assert.equal(message.length, 200);
  assert.ok(message.startsWith("*** "));
  assert.ok(message.endsWith("…"));
  assert.ok(!contents.includes("secret"));
});

/** A scripted `EventLog` that records what it was asked to append. */
function fakeEventLog(): EventLog & { readonly appended: RunEvent[] } {
  const appended: RunEvent[] = [];
  let seq = 1;
  return {
    appended,
    async append(event: NewEvent): Promise<RunEvent> {
      const written = { ...event, seq, at: new Date().toISOString() } as RunEvent;
      seq += 1;
      appended.push(written);
      return written;
    },
    async close(): Promise<void> {},
  };
}

test("attempt.started shows resolved fields in map order", async () => {
  const path = newPath();
  const events = withActivityHook(fakeEventLog(), path);

  await events.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
    fields: {
      profile: "implement.high",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    },
  });

  const contents = await readFile(path, "utf8");
  assert.match(
    contents,
    /001-implement step started profile implement\.high harness claude model claude-opus-5-5 effort high\n$/,
  );
});

test("iteration starts show fields or no fields, and iteration ends write no line", async () => {
  const path = newPath();
  const events = withActivityHook(fakeEventLog(), path);

  await events.append({
    type: "iteration.started",
    attemptId: "001-loop",
    iteration: 2,
    processGroupId: 1,
    fields: { model: "opus", effort: "high" },
  });
  await events.append({
    type: "iteration.ended",
    attemptId: "001-loop",
    iteration: 2,
    reason: "no_outcome",
  });
  await events.append({
    type: "iteration.started",
    attemptId: "001-loop",
    iteration: 2,
    processGroupId: 2,
  });

  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /001-loop iteration 2 started model opus effort high$/);
  assert.match(lines[1] ?? "", /001-loop iteration 2 started$/);
});

test("bad_field attempt ends show a quoted value only when present", async () => {
  const path = newPath();
  const events = withActivityHook(fakeEventLog(), path);

  await events.append({
    type: "attempt.ended",
    attemptId: "001-effort",
    result: "failure",
    reason: "bad_field",
    field: "effort",
    value: "hgih",
  });
  await events.append({
    type: "attempt.ended",
    attemptId: "002-model",
    result: "failure",
    reason: "bad_field",
    field: "model",
  });

  const lines = (await readFile(path, "utf8")).split("\n");
  assert.match(lines[0] ?? "", /001-effort step ended bad field effort "hgih"$/);
  assert.match(lines[1] ?? "", /002-model step ended bad field model$/);
});

test("attempt.started without fields, including a Ralph attempt, stays step started", async () => {
  const path = newPath();
  const events = withActivityHook(fakeEventLog(), path);

  await events.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });
  await events.append({
    type: "attempt.started",
    attemptId: "002-loop",
    stepId: "loop",
    processGroupId: 2,
  });

  const lines = (await readFile(path, "utf8")).split("\n");
  assert.match(lines[0] ?? "", /001-implement step started$/);
  assert.match(lines[1] ?? "", /002-loop step started$/);
});

test("withActivityHook writes nothing for an event ADR 0007 does not name", async () => {
  const path = newPath();
  const events = withActivityHook(fakeEventLog(), path);

  await events.append({ type: "owner.started", pid: 1, host: "ada" });

  await assert.rejects(() => readFile(path, "utf8"), /ENOENT/);
});

test("withActivityHook still returns the written event from the wrapped log", async () => {
  const path = newPath();
  const inner = fakeEventLog();
  const events = withActivityHook(inner, path);

  const written = await events.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });

  assert.equal(written.seq, 1);
  assert.deepEqual(inner.appended, [written]);
});

test("withActivityHook closes the wrapped log", async () => {
  const path = newPath();
  let closed = false;
  const events = withActivityHook(
    {
      async append(event: NewEvent): Promise<RunEvent> {
        return { ...event, seq: 1, at: new Date().toISOString() } as RunEvent;
      },
      async close(): Promise<void> {
        closed = true;
      },
    },
    path,
  );

  await events.close();
  assert.equal(closed, true);
});

test("withActivityHook swallows a failed activity write rather than failing the append", async () => {
  const events = withActivityHook(fakeEventLog(), join(scratch, "no-such-dir", "activity.log"));

  const written = await events.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });

  assert.equal(written.type, "attempt.started");
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
