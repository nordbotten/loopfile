import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import { continuePlan, continueRefusal } from "./continue.ts";

const workflow = {
  formatVersion: 1,
  inputs: {},
  steps: [{ id: "work" }, { id: "next" }],
} as unknown as Workflow;

function event(type: string, fields: Record<string, unknown> = {}): RunEvent {
  return { type, seq: 1, at: "2026-01-01T00:00:00.000Z", ...fields } as RunEvent;
}

function ended(reason: string, extra: Record<string, unknown> = {}) {
  return [
    event("run.created", { runId: "run-1", loopId: undefined }),
    event("attempt.started", { attemptId: "001-work", stepId: "work", processGroupId: 0 }),
    event("attempt.ended", { attemptId: "001-work", result: "failure", reason: "nonzero_exit" }),
    event("run.ended", { result: "failure", reason, ...extra }),
  ];
}

test("continue retries the cancelled or timed-out attempt without routing", () => {
  for (const terminal of [
    event("run.cancelled"),
    event("run.ended", { result: "failure", reason: "run_timeout" }),
  ]) {
    const events = [
      event("run.created", { runId: "run-1" }),
      event("attempt.started", { attemptId: "001-work", stepId: "work", processGroupId: 0 }),
      event("attempt.interrupted", { attemptId: "001-work" }),
      terminal,
    ];
    assert.deepEqual(continuePlan(workflow, events), { kind: "step", stepId: "work" });
  }
});

test("continue retries an attempt routed to the failure end state", () => {
  const events = [
    ...ended("end_state").slice(0, 3),
    event("transition", {
      from: "work",
      attemptId: "001-work",
      result: "failure",
      reason: "nonzero_exit",
      to: "$failure",
      cause: "onFailure",
    }),
    event("run.ended", { result: "failure", reason: "end_state" }),
  ];
  assert.deepEqual(continuePlan(workflow, events), { kind: "step", stepId: "work" });
});

test("continue retries the step named by an attempt limit", () => {
  assert.deepEqual(
    continuePlan(workflow, [
      ...ended("attempt_limit", { stepId: "next" }).slice(0, 3),
      event("transition", {
        from: "work",
        attemptId: "001-work",
        result: "success",
        reason: "clean_exit",
        to: "next",
        cause: "next",
      }),
      event("run.ended", { result: "failure", reason: "attempt_limit", stepId: "next" }),
    ]),
    { kind: "step", stepId: "next" },
  );
});

test("continue routes an attempt whose transition limit refused its move", () => {
  const events = [
    ...ended("transition_limit").slice(0, 3),
    event("run.ended", { result: "failure", reason: "transition_limit" }),
  ];
  assert.deepEqual(continuePlan(workflow, events), {
    kind: "route",
    stepId: "work",
    attemptId: "001-work",
    end: { result: "failure", reason: "nonzero_exit" },
  });
});

test("continue routes the last result when run timeout refused a between-attempt move", () => {
  const events = [
    ...ended("run_timeout").slice(0, 3),
    event("run.ended", { result: "failure", reason: "run_timeout" }),
  ];
  assert.deepEqual(continuePlan(workflow, events), {
    kind: "route",
    stepId: "work",
    attemptId: "001-work",
    end: { result: "failure", reason: "nonzero_exit" },
  });
});

test("continue retries the source step of an outcome routed to $failure", () => {
  const events = [
    event("run.created", { runId: "run-1" }),
    event("attempt.started", { attemptId: "001-work", stepId: "work", processGroupId: 0 }),
    event("attempt.ended", {
      attemptId: "001-work",
      result: "success",
      reason: "outcome",
      outcome: "blocked",
    }),
    event("transition", {
      from: "work",
      attemptId: "001-work",
      result: "success",
      reason: "outcome",
      outcome: "blocked",
      to: "$failure",
      cause: "on",
    }),
    event("run.ended", { result: "failure", reason: "end_state" }),
  ];
  assert.deepEqual(continuePlan(workflow, events), { kind: "step", stepId: "work" });
});

test("continue rejects internal errors instead of planning a step", () => {
  assert.throws(() => continuePlan(workflow, ended("internal_error")), /resume/);
});

test("continue retries the step named by the run end once the new owner has written run.continued", () => {
  const events = [
    ...ended("end_state").slice(0, 3),
    event("transition", {
      from: "work",
      attemptId: "001-work",
      result: "failure",
      reason: "nonzero_exit",
      to: "$failure",
      cause: "onFailure",
    }),
    event("run.ended", { result: "failure", reason: "end_state" }),
    event("owner.started", { pid: 7, host: "box" }),
    event("run.continued"),
  ];
  assert.deepEqual(continuePlan(workflow, events), { kind: "step", stepId: "work" });
});

test("continue plans from a later cancel, not from an earlier run end", () => {
  const events = [
    ...ended("end_state").slice(0, 3),
    event("transition", {
      from: "work",
      attemptId: "001-work",
      result: "failure",
      reason: "nonzero_exit",
      to: "$failure",
      cause: "onFailure",
    }),
    event("run.ended", { result: "failure", reason: "end_state" }),
    event("owner.started", { pid: 7, host: "box" }),
    event("run.continued"),
    event("attempt.started", { attemptId: "002-work", stepId: "work", processGroupId: 0 }),
    event("attempt.ended", { attemptId: "002-work", result: "success", reason: "clean_exit" }),
    event("transition", {
      from: "work",
      attemptId: "002-work",
      result: "success",
      reason: "clean_exit",
      to: "next",
      cause: "next",
    }),
    event("attempt.started", { attemptId: "003-next", stepId: "next", processGroupId: 0 }),
    event("attempt.interrupted", { attemptId: "003-next" }),
    event("run.cancelled"),
    event("owner.started", { pid: 8, host: "box" }),
    event("run.continued"),
  ];
  assert.deepEqual(continuePlan(workflow, events), { kind: "step", stepId: "next" });
});

test("continue routes the last attempt result when the log has no run end", () => {
  assert.deepEqual(continuePlan(workflow, ended("end_state").slice(0, 3)), {
    kind: "route",
    stepId: "work",
    attemptId: "001-work",
    end: { result: "failure", reason: "nonzero_exit" },
  });
});

test("continue takes the step from the attempt limit, not from the last attempt result", () => {
  assert.deepEqual(continuePlan(workflow, ended("attempt_limit", { stepId: "work" })), {
    kind: "step",
    stepId: "work",
  });
});

test("continue rejects an attempt limit without a step ID", () => {
  assert.throws(() => continuePlan(workflow, ended("attempt_limit")), {
    message: "attempt_limit is missing its step ID",
  });
});

test("continue rejects an end state run without a move to an end state", () => {
  const events = [
    ...ended("end_state").slice(0, 3),
    event("transition", {
      from: "work",
      attemptId: "001-work",
      result: "failure",
      reason: "nonzero_exit",
      to: "next",
      cause: "onFailure",
    }),
    event("run.ended", { result: "failure", reason: "end_state" }),
  ];
  assert.throws(() => continuePlan(workflow, events), {
    message: "end_state is missing its transition",
  });
});

test("continue rejects a run whose last move went to an end state without a run end that names a step", () => {
  const events = [
    ...ended("end_state").slice(0, 3),
    event("transition", {
      from: "work",
      attemptId: "001-work",
      result: "failure",
      reason: "nonzero_exit",
      to: "$failure",
      cause: "onFailure",
    }),
    event("run.cancelled"),
  ];
  assert.throws(() => continuePlan(workflow, events), {
    message: "the ended run has no stopped step to continue",
  });
});

const created = event("run.created", {
  runId: "run-1",
  eventFormatVersion: 1,
  modelDigest: "sha256:model",
});

test("a failed or cancelled run with the same model may be continued", () => {
  for (const terminal of [
    event("run.ended", { result: "failure", reason: "end_state" }),
    event("run.cancelled"),
  ]) {
    assert.equal(continueRefusal([created, terminal], "sha256:model"), undefined);
  }
});

test("a crashed run is refused and pointed at resume", () => {
  assert.equal(
    continueRefusal([created], "sha256:model"),
    "run run-1 is crashed. Resume it with `loopfile resume run-1`.",
  );
});

test("an internal error run is refused and pointed at resume", () => {
  const events = [created, event("run.ended", { result: "failure", reason: "internal_error" })];
  assert.equal(
    continueRefusal(events, "sha256:model"),
    "run run-1 ended with internal_error. Resume it with `loopfile resume run-1`.",
  );
});

test("a completed run is refused and pointed at a new run", () => {
  const events = [created, event("run.ended", { result: "success", reason: "end_state" })];
  assert.equal(
    continueRefusal(events, "sha256:model"),
    "run run-1 completed and cannot be continued. Start a new run instead.",
  );
});

test("a child run of a loop is refused", () => {
  const events = [
    event("run.created", {
      runId: "run-1",
      eventFormatVersion: 1,
      modelDigest: "sha256:model",
      loopId: "loop-1",
    }),
    event("run.ended", { result: "failure", reason: "end_state" }),
  ];
  assert.equal(
    continueRefusal(events, "sha256:model"),
    "run run-1 is a child of loop loop-1 and cannot be continued individually.",
  );
});

test("a run whose model changed is refused", () => {
  const events = [created, event("run.ended", { result: "failure", reason: "end_state" })];
  assert.equal(
    continueRefusal(events, "sha256:other"),
    "the Materialized Loopfile of run run-1 no longer builds the model the run started with.\n" +
      "  run.created model digest: sha256:model\n" +
      "  model digest now:         sha256:other",
  );
});
