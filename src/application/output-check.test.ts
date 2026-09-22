import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { CommandStep } from "../domain/model.ts";
import { checkOutputs } from "./output-check.ts";

function step(fields: Partial<CommandStep> = {}): CommandStep {
  return {
    id: "review",
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

let seq = 0;
function put(attemptId: string, key: string): RunEvent {
  seq += 1;
  return {
    seq,
    at: `2026-09-18T00:00:${String(seq).padStart(2, "0")}Z`,
    type: "data.put",
    attemptId,
    key,
    size: 1,
    digest: "digest",
  } as RunEvent;
}

test("a step with no declared outputs always passes", () => {
  assert.deepEqual(checkOutputs(step({ outputs: {} }), [], "001-review", undefined), {
    allowed: true,
  });
});

test("list form: a clean exit without the put fails the attempt", () => {
  const withOutput = step({ outputs: { feedback: [] } });
  assert.deepEqual(checkOutputs(withOutput, [], "001-review", undefined), {
    allowed: false,
    output: "feedback",
  });
});

test("list form: a clean exit with the put passes", () => {
  const withOutput = step({ outputs: { feedback: [] } });
  const events = [put("001-review", "review.feedback")];
  assert.deepEqual(checkOutputs(withOutput, events, "001-review", undefined), { allowed: true });
});

test("map form: required on the outcome that lists it", () => {
  const withOutput = step({
    outputs: { feedback: ["changes_requested"] },
    on: { changes_requested: "fix", approved: "$success" },
  });
  assert.deepEqual(checkOutputs(withOutput, [], "001-review", "changes_requested"), {
    allowed: false,
    output: "feedback",
  });
});

test("map form: not required on an outcome that does not list it", () => {
  const withOutput = step({
    outputs: { feedback: ["changes_requested"] },
    on: { changes_requested: "fix", approved: "$success" },
  });
  assert.deepEqual(checkOutputs(withOutput, [], "001-review", "approved"), { allowed: true });
});

test("a value put by an earlier attempt of the same step does not satisfy the check", () => {
  const withOutput = step({ outputs: { feedback: [] } });
  const events = [put("000-review", "review.feedback")];
  assert.deepEqual(checkOutputs(withOutput, events, "001-review", undefined), {
    allowed: false,
    output: "feedback",
  });
});

test("a Ralph attempt passes when an earlier iteration of the same attempt put the key", () => {
  const withOutput = step({ kind: "command", outputs: { feedback: [] } });
  const events = [put("001-review", "review.feedback")];
  assert.deepEqual(checkOutputs(withOutput, events, "001-review", undefined), { allowed: true });
});

test("undeclared extra puts do not fail the attempt", () => {
  const withOutput = step({ outputs: { feedback: [] } });
  const events = [put("001-review", "review.feedback"), put("001-review", "review.notes")];
  assert.deepEqual(checkOutputs(withOutput, events, "001-review", undefined), { allowed: true });
});

test("more than one missing output reports the first in declaration order", () => {
  const withOutput = step({ outputs: { feedback: [], summary: [] } });
  assert.deepEqual(checkOutputs(withOutput, [], "001-review", undefined), {
    allowed: false,
    output: "feedback",
  });
});
