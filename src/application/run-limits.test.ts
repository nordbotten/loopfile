import assert from "node:assert/strict";
import { test } from "node:test";
import { FORMAT_VERSION, type Workflow } from "../domain/model.ts";
import { checkRunTimeout, checkTransitionLimit } from "./run-limits.ts";

function workflow(fields: Partial<Workflow> = {}): Workflow {
  return { formatVersion: FORMAT_VERSION, inputs: {}, steps: [], ...fields };
}

test("no maxTransitions means no transition limit", () => {
  assert.deepEqual(checkTransitionLimit(workflow(), 1_000_000), { allowed: true });
});

test("a transition count under maxTransitions is allowed", () => {
  assert.deepEqual(checkTransitionLimit(workflow({ maxTransitions: 3 }), 2), { allowed: true });
});

test("a count that already equals maxTransitions ends the run in failure", () => {
  assert.deepEqual(checkTransitionLimit(workflow({ maxTransitions: 3 }), 3), {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "transition_limit" },
  });
});

test("a count past maxTransitions is refused", () => {
  assert.deepEqual(checkTransitionLimit(workflow({ maxTransitions: 3 }), 4), {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "transition_limit" },
  });
});

test("a run whose last move brings the count to maxTransitions is itself allowed", () => {
  // The move that took the count from 2 to 3 was checked at count 2, under the
  // limit of 3, so it was allowed. The run may then end normally at $success
  // without ever being refused.
  assert.deepEqual(checkTransitionLimit(workflow({ maxTransitions: 3 }), 2), { allowed: true });
});

test("no runTimeoutMs means no run time limit", () => {
  assert.deepEqual(checkRunTimeout(workflow(), 1_000_000_000), { allowed: true });
});

test("owner time under runTimeoutMs is allowed", () => {
  assert.deepEqual(checkRunTimeout(workflow({ runTimeoutMs: 60_000 }), 30_000), {
    allowed: true,
  });
});

test("owner time at runTimeoutMs ends the run in failure", () => {
  assert.deepEqual(checkRunTimeout(workflow({ runTimeoutMs: 60_000 }), 60_000), {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "run_timeout" },
  });
});

test("owner time past runTimeoutMs is refused", () => {
  assert.deepEqual(checkRunTimeout(workflow({ runTimeoutMs: 60_000 }), 90_000), {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "run_timeout" },
  });
});
