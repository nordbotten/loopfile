import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { CommandStep } from "../domain/model.ts";
import { endOfAttempt, endStateEvent, START_FAILED_END } from "./workflow-run.ts";

function step(fields: Partial<CommandStep> = {}): CommandStep {
  return {
    id: "build",
    kind: "command",
    run: "true",
    on: {},
    onFailure: "$failure",
    outputs: {},
    maxAttempts: 5,
    timeoutMs: 1000,
    ...fields,
  };
}

const clean = { kind: "exited", code: 0 } as const;
const put = (key: string): RunEvent => ({
  type: "data.put",
  seq: 1,
  at: "2026-09-18T12:00:00.000Z",
  attemptId: "001-build",
  key,
  size: 1,
  digest: "d",
});

test("a clean exit with no outcome succeeds on a step with no outcomes", () => {
  assert.deepEqual(endOfAttempt(step(), [], "001-build", clean), {
    result: "success",
    reason: "clean_exit",
  });
});

test("a nonzero exit fails and a signal fails", () => {
  const code = endOfAttempt(step(), [], "001-build", { kind: "exited", code: 1 });
  assert.deepEqual(code, { result: "failure", reason: "nonzero_exit" });
  const signal = endOfAttempt(step(), [], "001-build", { kind: "signalled", signal: "SIGTERM" });
  assert.deepEqual(signal, { result: "failure", reason: "nonzero_exit" });
});

test("a missing required output fails a clean exit and names the output", () => {
  const withOutput = step({ outputs: { log: [] } });
  assert.deepEqual(endOfAttempt(withOutput, [], "001-build", clean), {
    result: "failure",
    reason: "missing_output",
    output: "log",
  });
  assert.deepEqual(endOfAttempt(withOutput, [put("build.log")], "001-build", clean), {
    result: "success",
    reason: "clean_exit",
  });
});

test("an output required only for another outcome does not fail this one", () => {
  const withOutput = step({ on: { a: "$success", b: "$success" }, outputs: { log: ["b"] } });
  const reported: RunEvent = {
    type: "outcome.reported",
    seq: 1,
    at: "2026-09-18T12:00:00.000Z",
    attemptId: "001-build",
    outcome: "a",
  };
  assert.deepEqual(endOfAttempt(withOutput, [reported], "001-build", clean), {
    result: "success",
    reason: "outcome",
    outcome: "a",
  });
  const missing = endOfAttempt(withOutput, [{ ...reported, outcome: "b" }], "001-build", clean);
  assert.deepEqual(missing, {
    result: "failure",
    reason: "missing_output",
    output: "log",
    outcome: "b",
  });
});

test("an outcome the step does not name fails and keeps the outcome", () => {
  const reported: RunEvent = {
    type: "outcome.reported",
    seq: 1,
    at: "2026-09-18T12:00:00.000Z",
    attemptId: "001-build",
    outcome: "other",
  };
  assert.deepEqual(endOfAttempt(step({ on: { a: "$success" } }), [reported], "001-build", clean), {
    result: "failure",
    reason: "outcome_not_allowed",
    outcome: "other",
  });
});

test("the end of a start that failed is a failure with its own reason", () => {
  assert.deepEqual(START_FAILED_END, { result: "failure", reason: "start_failed" });
});

test("an end state becomes the run's result", () => {
  assert.deepEqual(endStateEvent("$success"), {
    type: "run.ended",
    result: "success",
    reason: "end_state",
  });
  assert.deepEqual(endStateEvent("$failure"), {
    type: "run.ended",
    result: "failure",
    reason: "end_state",
  });
});
