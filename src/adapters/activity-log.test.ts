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

test("appendActivity redacts a given secret before writing", async () => {
  const path = newPath();
  await appendActivity(path, "001-implement", "endpoint /tmp/sock secret abc123", {
    attemptSecret: "abc123",
    environmentValues: ["/tmp/sock"],
  });

  const contents = await readFile(path, "utf8");
  assert.ok(!contents.includes("abc123"));
  assert.ok(!contents.includes("/tmp/sock"));
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

test("withActivityHook writes a lifecycle line for an event ADR 0007 names", async () => {
  const path = newPath();
  const events = withActivityHook(fakeEventLog(), path);

  await events.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });

  const contents = await readFile(path, "utf8");
  assert.match(contents, /001-implement step started\n$/);
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
