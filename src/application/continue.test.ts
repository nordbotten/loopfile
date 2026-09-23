import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import { continuePlan } from "./continue.ts";

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
