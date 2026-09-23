import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { CommandStep, Workflow } from "../domain/model.ts";
import { resumePlan, resumeRefusal } from "./resume.ts";
import { modelDigest } from "./workflow-run.ts";

function step(id: string): CommandStep {
  return {
    id,
    kind: "command",
    run: "true",
    on: {},
    onFailure: "$failure",
    outputs: {},
    maxAttempts: 5,
    timeoutMs: 1_000,
  };
}

const workflow: Workflow = { formatVersion: 1, inputs: {}, steps: [step("build"), step("test")] };

/** Events with `seq` and `at` filled in, in order. */
function log(...events: readonly Record<string, unknown>[]): RunEvent[] {
  return events.map(
    (event, index) =>
      ({ seq: index + 1, at: "2026-09-19T10:00:00.000Z", ...event }) as unknown as RunEvent,
  );
}

const created = {
  type: "run.created",
  runId: "r-1",
  eventFormatVersion: 1,
  modelDigest: "sha256:model",
  repositoryPath: "/repo",
  baseCommit: "abc",
  branch: "loopfile/r-1",
  inputs: [],
};
const owner = { type: "owner.started", pid: 7, host: "box" };
const started = (attemptId: string, stepId: string, processGroupId = 91) => ({
  type: "attempt.started",
  attemptId,
  stepId,
  processGroupId,
});
const ended = (attemptId: string, extra: Record<string, unknown> = {}) => ({
  type: "attempt.ended",
  attemptId,
  result: "success",
  reason: "clean_exit",
  ...extra,
});
const transition = (from: string, attemptId: string, to: string) => ({
  type: "transition",
  from,
  attemptId,
  result: "success",
  reason: "clean_exit",
  to,
  cause: "next",
});

test("a crashed run with the same model may be resumed", () => {
  assert.equal(resumeRefusal(log(created, owner), "sha256:model"), undefined);
});

test("an ended run is refused and named as ended, with its result", () => {
  const events = log(created, owner, { type: "run.ended", result: "failure", reason: "end_state" });
  const message = resumeRefusal(events, "sha256:model") ?? "";
  assert.match(message, /^run r-1 has ended \(failure\)\. /);
  assert.match(message, /Continue it with `loopfile continue r-1`\.$/);
});

test("an internal error run may be resumed", () => {
  const events = log(created, owner, {
    type: "run.ended",
    result: "failure",
    reason: "internal_error",
  });
  assert.equal(resumeRefusal(events, "sha256:model"), undefined);
});

test("a second internal error without an attempt is refused", () => {
  const events = log(
    created,
    owner,
    { type: "run.ended", result: "failure", reason: "internal_error" },
    owner,
    { type: "run.ended", result: "failure", reason: "internal_error" },
  );
  assert.equal(
    resumeRefusal(events, "sha256:model"),
    "run r-1 has ended (internal_error). Resume is only for a crashed run.",
  );
});

test("a completed run is refused as completed, not as merely ended", () => {
  const events = log(created, owner, { type: "run.ended", result: "success", reason: "end_state" });
  assert.equal(
    resumeRefusal(events, "sha256:model"),
    "run r-1 completed. Resume is only for a crashed run.",
  );
});

test("an internal error after an attempt may be resumed", () => {
  const events = log(
    created,
    owner,
    { type: "run.ended", result: "failure", reason: "internal_error" },
    owner,
    started("001-build", "build"),
    { type: "run.ended", result: "failure", reason: "internal_error" },
  );
  assert.equal(resumeRefusal(events, "sha256:model"), undefined);
});

test("a cancelled run is refused and named as cancelled", () => {
  const events = log(created, owner, { type: "run.cancelled" });
  assert.equal(
    resumeRefusal(events, "sha256:model"),
    "run r-1 was cancelled. Continue it with `loopfile continue r-1`.",
  );
});

test("an event format version this tool does not read is refused with both versions", () => {
  const events = log({ ...created, eventFormatVersion: 2 }, owner);
  assert.equal(
    resumeRefusal(events, "sha256:model"),
    "run r-1 has event format version 2, and this loopfile reads only version 1.",
  );
});

test("a changed model is refused and the error shows both digests", () => {
  const message = resumeRefusal(log(created, owner), "sha256:other") ?? "";
  assert.equal(
    message,
    "the Materialized Loopfile of run r-1 no longer builds the model the run started with.\n" +
      "  run.created model digest: sha256:model\n" +
      "  model digest now:         sha256:other",
  );
});

test("a run with no attempt yet goes on at the entry step", () => {
  assert.deepEqual(resumePlan(workflow, log(created, owner)), {
    next: { kind: "step", stepId: "build" },
  });
});

test("an attempt with a start and no end is interrupted, and its step gets a new attempt", () => {
  const events = log(
    created,
    owner,
    started("001-build", "build"),
    ended("001-build"),
    transition("build", "001-build", "test"),
    started("002-test", "test", 314),
    { type: "data.put", attemptId: "002-test", key: "test.k", size: 1, digest: "d" },
  );
  const plan = resumePlan(workflow, events);
  assert.equal(plan.interrupted?.attemptId, "002-test");
  assert.equal(plan.interrupted?.processGroupId, 314);
  assert.equal(plan.leftoverGroup, 314);
  assert.deepEqual(plan.next, { kind: "step", stepId: "test" });
});

const iteration = (attemptId: string, number: number, processGroupId: number) => ({
  type: "iteration.started",
  attemptId,
  iteration: number,
  processGroupId,
});

test("an interrupted Ralph attempt leaves the group of its last started iteration", () => {
  const events = log(
    created,
    owner,
    started("001-build", "build", 0),
    iteration("001-build", 1, 501),
    { type: "iteration.ended", attemptId: "001-build", iteration: 1, reason: "no_outcome" },
    iteration("001-build", 2, 502),
  );
  assert.equal(resumePlan(workflow, events).leftoverGroup, 502);
});

test("an interrupted Ralph attempt with no iteration yet leaves no group", () => {
  const events = log(created, owner, started("001-build", "build", 0));
  assert.equal(resumePlan(workflow, events).leftoverGroup, 0);
});

test("an iteration of an earlier, ended attempt is not the interrupted attempt's group", () => {
  const events = log(
    created,
    owner,
    started("001-build", "build", 0),
    iteration("001-build", 1, 501),
    ended("001-build"),
    transition("build", "001-build", "test"),
    started("002-test", "test", 77),
  );
  assert.equal(resumePlan(workflow, events).leftoverGroup, 77);
});

test("an attempt already interrupted by an earlier resume is not interrupted twice", () => {
  const events = log(created, owner, started("001-build", "build"), owner, {
    type: "attempt.interrupted",
    attemptId: "001-build",
  });
  assert.deepEqual(resumePlan(workflow, events), { next: { kind: "step", stepId: "build" } });
});

test("an attempt that ended before its transition was written is routed now", () => {
  const events = log(
    created,
    owner,
    started("001-build", "build"),
    ended("001-build", { result: "failure", reason: "missing_output", output: "log" }),
  );
  assert.deepEqual(resumePlan(workflow, events), {
    next: {
      kind: "route",
      stepId: "build",
      attemptId: "001-build",
      end: { result: "failure", reason: "missing_output", output: "log" },
    },
  });
});

test("a transition to a step goes on at that step", () => {
  const events = log(
    created,
    owner,
    started("001-build", "build"),
    ended("001-build"),
    transition("build", "001-build", "test"),
  );
  assert.deepEqual(resumePlan(workflow, events), { next: { kind: "step", stepId: "test" } });
});

test("a transition to an end state ends the run there", () => {
  const events = log(
    created,
    owner,
    started("001-build", "build"),
    ended("001-build"),
    transition("build", "001-build", "$failure"),
  );
  assert.deepEqual(resumePlan(workflow, events), { next: { kind: "end", state: "$failure" } });
});

test("the model digest is the SHA-256 of the model's JSON", () => {
  assert.match(modelDigest(workflow), /^[0-9a-f]{64}$/);
  assert.equal(modelDigest(workflow), modelDigest(structuredClone(workflow)));
  assert.notEqual(modelDigest(workflow), modelDigest({ ...workflow, maxTransitions: 3 }));
});
