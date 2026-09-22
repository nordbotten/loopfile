import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEventLog, replay } from "../application/replay.ts";
import { transitionEvent } from "../application/routing.ts";
import type { LoopEvent } from "../domain/events.ts";
import type { CommandStep, Workflow } from "../domain/model.ts";
import { FORMAT_VERSION } from "../domain/model.ts";
import { openEventLog } from "./event-log.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-events-"));
let counter = 0;

function newLogPath(): string {
  counter += 1;
  return join(scratch, `events-${counter}.jsonl`);
}

const CREATED = {
  type: "run.created",
  runId: "20260917-160344-k3f9",
  eventFormatVersion: 1,
  modelDigest: "sha256:abc",
  repositoryPath: "/home/ada/repo",
  baseCommit: "c0ffee",
  branch: "loopfile/20260917-160344-k3f9",
  inputs: [],
} as const;

test("a new log starts at seq 1 and reads back as events", async () => {
  const path = newLogPath();
  const log = await openEventLog(path);
  const created = await log.append({ ...CREATED });
  const owner = await log.append({ type: "owner.started", pid: 42, host: "ada" });
  await log.close();

  assert.equal(created.seq, 1);
  assert.equal(owner.seq, 2);
  assert.match(owner.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(parseEventLog(await readFile(path, "utf8")), [created, owner]);
});

test("each event is one line of its own", async () => {
  const path = newLogPath();
  const log = await openEventLog(path);
  await log.append({ ...CREATED });
  await log.append({ type: "owner.started", pid: 42, host: "ada" });
  await log.close();

  const lines = (await readFile(path, "utf8")).split("\n");
  assert.equal(lines.at(-1), "", "the file ends with a newline");
  assert.equal(lines.length, 3);
});

test("the same append path writes and reads a loop event log", async () => {
  const path = newLogPath();
  const log = await openEventLog<LoopEvent>(path);
  const created = await log.append({
    type: "loop.created",
    loopId: "loop-20260917-160344-k3f9",
    eventFormatVersion: 1,
    repositoryPath: "/home/ada/repo",
    loopfileName: "review",
    source: { kind: "times", count: 2 },
    fixedInputs: { issue: "42" },
    retry: 1,
    maxRuns: 4,
    pauseMs: null,
    program: { version: "0.1.0", digest: "sha256:program" },
  });
  const ended = await log.append({
    type: "loop.ended",
    result: "success",
    reason: "max_runs",
  });
  await log.close();

  assert.equal(created.seq, 1);
  assert.equal(ended.seq, 2);
  assert.deepEqual(parseEventLog<LoopEvent>(await readFile(path, "utf8")), [created, ended]);
});

test("a resumed run continues the numbering instead of restarting it", async () => {
  const path = newLogPath();
  const first = await openEventLog(path);
  await first.append({ ...CREATED });
  await first.append({ type: "owner.started", pid: 42, host: "ada" });
  await first.close();

  const second = await openEventLog(path);
  const resumed = await second.append({ type: "owner.started", pid: 43, host: "ada" });
  await second.close();
  assert.equal(resumed.seq, 3);
});

test("a last line a crash cut in half does not break the numbering", async () => {
  const path = newLogPath();
  const log = await openEventLog(path);
  await log.append({ ...CREATED });
  await log.close();
  await writeFile(path, '{"seq":2,"at":"2026-09-17T16:03:', { flag: "a" });

  const resumed = await openEventLog(path);
  const next = await resumed.append({ type: "owner.started", pid: 43, host: "ada" });
  await resumed.close();
  assert.equal(next.seq, 2, "the half line is not an event, so seq 2 is still free");
});

test("a caller may fix the timestamp, and the log keeps it", async () => {
  const path = newLogPath();
  const log = await openEventLog(path);
  const at = "2026-09-17T16:03:44.000Z";
  const created = await log.append({ ...CREATED, at });
  await log.close();
  assert.equal(created.at, at);
});

function step(id: string, fields: Partial<CommandStep> = {}): CommandStep {
  return {
    id,
    kind: "command",
    run: "true",
    on: {},
    onFailure: "$failure",
    outputs: {},
    maxAttempts: 5,
    timeoutMs: 3_600_000,
    ...fields,
  };
}

/** implement → test, cycling back through implement on a failed outcome (#28's cycle case). */
const workflow: Workflow = {
  formatVersion: FORMAT_VERSION,
  inputs: {},
  steps: [step("implement"), step("test", { on: { passed: "$success", failed: "implement" } })],
};

test("a transition lands on disk before the next attempt starts, and replay rebuilds the cycle", async () => {
  const path = newLogPath();
  const log = await openEventLog(path);
  await log.append({ ...CREATED });
  await log.append({ type: "owner.started", pid: 42, host: "ada" });

  // implement (001) ends cleanly and falls through to test: cause "next".
  await log.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });
  await log.append({
    type: "attempt.ended",
    attemptId: "001-implement",
    result: "success",
    reason: "clean_exit",
  });
  await log.append(
    transitionEvent(workflow, "implement", "001-implement", {
      result: "success",
      reason: "clean_exit",
    }),
  );

  // test (002) fails → implement (003): the cycle, cause "on".
  await log.append({
    type: "attempt.started",
    attemptId: "002-test",
    stepId: "test",
    processGroupId: 2,
  });
  await log.append({
    type: "attempt.ended",
    attemptId: "002-test",
    result: "success",
    reason: "outcome",
    outcome: "failed",
  });
  await log.append(
    transitionEvent(workflow, "test", "002-test", {
      result: "success",
      reason: "outcome",
      outcome: "failed",
    }),
  );

  await log.append({
    type: "attempt.started",
    attemptId: "003-implement",
    stepId: "implement",
    processGroupId: 3,
  });
  await log.append({
    type: "attempt.ended",
    attemptId: "003-implement",
    result: "success",
    reason: "clean_exit",
  });
  await log.append(
    transitionEvent(workflow, "implement", "003-implement", {
      result: "success",
      reason: "clean_exit",
    }),
  );

  // test (004) passes and ends the run: cause "on", to the end state.
  await log.append({
    type: "attempt.started",
    attemptId: "004-test",
    stepId: "test",
    processGroupId: 4,
  });
  await log.append({
    type: "attempt.ended",
    attemptId: "004-test",
    result: "success",
    reason: "outcome",
    outcome: "passed",
  });
  await log.append(
    transitionEvent(workflow, "test", "004-test", {
      result: "success",
      reason: "outcome",
      outcome: "passed",
    }),
  );
  await log.close();

  const events = parseEventLog(await readFile(path, "utf8"));
  const transitions = events.filter((event) => event.type === "transition");
  assert.equal(
    transitions.length,
    4,
    "one event per move, including the cycle back through implement",
  );
  assert.deepEqual(
    transitions.map((event) => event.cause),
    ["next", "on", "next", "on"],
  );
  assert.deepEqual(
    transitions.map((event) => event.to),
    ["test", "implement", "test", "$success"],
  );
  // Every transition's seq is one past the attempt.ended that caused it, so a
  // reader never finds a started attempt with no transition recorded before it.
  for (const transition of transitions) {
    const causedBy = events.find(
      (event) => event.type === "attempt.ended" && event.seq === transition.seq - 1,
    );
    assert.ok(causedBy, `transition at seq ${transition.seq} follows the attempt it routes`);
  }

  const state = replay(events);
  assert.equal(state.transitions.length, 4);
  assert.equal(state.attempts.test?.length, 2, "test is visited twice in the cycle");
  assert.equal(state.attempts.implement?.length, 2, "implement is visited twice in the cycle");
  assert.equal(state.currentStep, "test");
});

test("events.jsonl alone gives the same history once every other run file is gone", async () => {
  const runDir = await mkdtemp(join(scratch, "run-"));
  const eventsPath = join(runDir, "events.jsonl");

  const log = await openEventLog(eventsPath);
  await log.append({ ...CREATED });
  await log.append({ type: "owner.started", pid: 42, host: "ada" });
  await log.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });
  await log.append({
    type: "attempt.ended",
    attemptId: "001-implement",
    result: "success",
    reason: "clean_exit",
  });
  await log.append(
    transitionEvent(workflow, "implement", "001-implement", {
      result: "success",
      reason: "clean_exit",
    }),
  );
  await log.append({
    type: "attempt.started",
    attemptId: "002-test",
    stepId: "test",
    processGroupId: 2,
  });
  await log.append({
    type: "attempt.ended",
    attemptId: "002-test",
    result: "success",
    reason: "outcome",
    outcome: "passed",
  });
  await log.append(
    transitionEvent(workflow, "test", "002-test", {
      result: "success",
      reason: "outcome",
      outcome: "passed",
    }),
  );
  await log.append({ type: "run.ended", result: "success", reason: "end_state" });
  await log.close();

  // Everything replay must never read (ADR 0003): the activity log, the
  // status projection, the run owner's own log, and an attempt folder's files.
  await writeFile(join(runDir, "activity.log"), "10:00 implement started\n10:01 implement ok\n");
  await writeFile(join(runDir, "status.json"), JSON.stringify({ step: "test", state: "running" }));
  await writeFile(join(runDir, "owner.log"), "owner pid 42 listening\n");
  await mkdir(join(runDir, "attempts", "001-implement"), { recursive: true });
  await writeFile(join(runDir, "attempts", "001-implement", "stdout.log"), "building...\n");
  await mkdir(join(runDir, "attempts", "002-test"), { recursive: true });
  await writeFile(
    join(runDir, "attempts", "002-test", "result.json"),
    JSON.stringify({ ok: true }),
  );

  const before = replay(parseEventLog(await readFile(eventsPath, "utf8")));

  await rm(join(runDir, "activity.log"));
  await rm(join(runDir, "status.json"));
  await rm(join(runDir, "owner.log"));
  await rm(join(runDir, "attempts"), { recursive: true });

  const after = replay(parseEventLog(await readFile(eventsPath, "utf8")));

  assert.deepEqual(after, before);
  assert.deepEqual(after.attempts, { implement: ["001-implement"], test: ["002-test"] });
  assert.deepEqual(after.transitions, [
    {
      from: "implement",
      attemptId: "001-implement",
      result: "success",
      reason: "clean_exit",
      to: "test",
      cause: "next",
    },
    {
      from: "test",
      attemptId: "002-test",
      result: "success",
      reason: "outcome",
      outcome: "passed",
      to: "$success",
      cause: "on",
    },
  ]);
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
