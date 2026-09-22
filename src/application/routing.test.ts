import assert from "node:assert/strict";
import { test } from "node:test";
import { type CommandStep, FORMAT_VERSION, type Workflow } from "../domain/model.ts";
import { type AttemptResult, route, transitionEvent, UnroutableAttemptError } from "./routing.ts";

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

/** build → test, with test routing on its two outcomes. */
const workflow: Workflow = {
  formatVersion: FORMAT_VERSION,
  inputs: {},
  steps: [
    step("build"),
    step("test", { on: { passed: "$success", failed: "fix" }, onFailure: "fix" }),
    step("fix"),
  ],
};

const outcome = (name: string): AttemptResult => ({
  result: "success",
  reason: "outcome",
  outcome: name,
});
const cleanExit: AttemptResult = { result: "success", reason: "clean_exit" };

test("an outcome takes its own route", () => {
  assert.deepEqual(route(workflow, "test", outcome("failed")), { to: "fix", cause: "on" });
});

test("an outcome route can end the run in success", () => {
  assert.deepEqual(route(workflow, "test", outcome("passed")), { to: "$success", cause: "on" });
});

test("a clean exit with no outcomes declared goes to the next step in the list", () => {
  assert.deepEqual(route(workflow, "build", cleanExit), { to: "test", cause: "next" });
});

test("a clean exit past the last step ends the run in success", () => {
  assert.deepEqual(route(workflow, "fix", cleanExit), { to: "$success", cause: "next" });
});

test("every failure takes onFailure, whatever the reason", () => {
  for (const reason of [
    "timeout",
    "nonzero_exit",
    "missing_output",
    "outcome_not_allowed",
    "iteration_limit",
    "start_failed",
  ] as const) {
    assert.deepEqual(route(workflow, "test", { result: "failure", reason }), {
      to: "fix",
      cause: "onFailure",
    });
  }
});

test("a failure on a step with no onFailure of its own ends the run in failure", () => {
  assert.deepEqual(route(workflow, "build", { result: "failure", reason: "nonzero_exit" }), {
    to: "$failure",
    cause: "onFailure",
  });
});

test("a failure never falls through to the next step", () => {
  assert.equal(
    route(workflow, "build", { result: "failure", reason: "timeout" }).cause,
    "onFailure",
  );
});

test("an outcome the step does not name is unroutable", () => {
  assert.throws(() => route(workflow, "test", outcome("approved")), UnroutableAttemptError);
});

test("a success reported with no outcome at all is unroutable", () => {
  assert.throws(
    () => route(workflow, "test", { result: "success", reason: "outcome" }),
    UnroutableAttemptError,
  );
});

test("a clean exit on a step that names outcomes is unroutable", () => {
  assert.throws(() => route(workflow, "test", cleanExit), UnroutableAttemptError);
});

test("an outcome that names an Object.prototype key is unroutable", () => {
  assert.throws(() => route(workflow, "test", outcome("constructor")), UnroutableAttemptError);
});

test("a success with any other reason is unroutable, never a fall-through", () => {
  assert.throws(
    () => route(workflow, "build", { result: "success", reason: "timeout" }),
    UnroutableAttemptError,
  );
});

test("a step the workflow does not have is unroutable", () => {
  assert.throws(() => route(workflow, "deploy", cleanExit), UnroutableAttemptError);
});

test("transitionEvent carries an on route's outcome", () => {
  assert.deepEqual(transitionEvent(workflow, "test", "002-test", outcome("failed")), {
    type: "transition",
    from: "test",
    attemptId: "002-test",
    result: "success",
    reason: "outcome",
    outcome: "failed",
    to: "fix",
    cause: "on",
  });
});

test("transitionEvent carries a next-in-list move with no outcome", () => {
  assert.deepEqual(transitionEvent(workflow, "build", "001-build", cleanExit), {
    type: "transition",
    from: "build",
    attemptId: "001-build",
    result: "success",
    reason: "clean_exit",
    to: "test",
    cause: "next",
  });
});

test("transitionEvent carries an onFailure move to an end state", () => {
  assert.deepEqual(
    transitionEvent(workflow, "build", "001-build", { result: "failure", reason: "timeout" }),
    {
      type: "transition",
      from: "build",
      attemptId: "001-build",
      result: "failure",
      reason: "timeout",
      to: "$failure",
      cause: "onFailure",
    },
  );
});

test("transitionEvent, called again for the step a cycle revisits, gives a fresh event", () => {
  const first = transitionEvent(workflow, "test", "002-test", outcome("failed"));
  const second = transitionEvent(workflow, "test", "004-test", outcome("failed"));

  assert.notEqual(first.attemptId, second.attemptId);
  assert.deepEqual({ ...first, attemptId: "shared" }, { ...second, attemptId: "shared" });
});
