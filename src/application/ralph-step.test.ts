import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { RalphStep } from "../domain/model.ts";
import {
  classifyIteration,
  ITERATION_LIMIT_END,
  iterationOutcome,
  outcomeEnd,
} from "./ralph-step.ts";

const ok = { kind: "exited", code: 0 } as const;
const bad = { kind: "exited", code: 2 } as const;

const step = {
  id: "loop",
  kind: "ralph",
  harness: "pi",
  promptFile: "p.md",
  args: [],
  on: { done: "$success" },
  onFailure: "$failure",
  outputs: {},
  maxAttempts: 5,
  timeoutMs: 1000,
  maxIterations: 10,
} as RalphStep;

function reported(attemptId: string, iteration: number, outcome: string): RunEvent {
  return { type: "outcome.reported", attemptId, iteration, outcome, seq: 1, at: "t" } as RunEvent;
}

test("a clean exit with an outcome ends on the outcome", () => {
  assert.equal(classifyIteration(ok, false, "done"), "outcome");
});

test("a clean exit with no outcome means continue", () => {
  assert.equal(classifyIteration(ok, false, undefined), "no_outcome");
});

test("a bad exit ignores the outcome", () => {
  assert.equal(classifyIteration(bad, false, "done"), "nonzero_exit");
  assert.equal(
    classifyIteration({ kind: "signalled", signal: "SIGKILL" }, false, undefined),
    "nonzero_exit",
  );
});

test("a timeout wins over the exit it caused", () => {
  assert.equal(
    classifyIteration({ kind: "signalled", signal: "SIGTERM" }, true, "done"),
    "timeout",
  );
  assert.equal(classifyIteration(ok, true, undefined), "timeout");
});

test("iterationOutcome reads the last outcome of this attempt and iteration only", () => {
  const history = [
    reported("a", 1, "x"),
    reported("a", 2, "y"),
    reported("b", 2, "z"),
    reported("a", 2, "done"),
  ];
  assert.equal(iterationOutcome(history, "a", 2), "done");
  assert.equal(iterationOutcome(history, "a", 1), "x");
  assert.equal(iterationOutcome(history, "a", 3), undefined);
  assert.equal(iterationOutcome([{ type: "iteration.started" } as RunEvent], "a", 1), undefined);
});

test("an outcome in on succeeds and one outside it fails", () => {
  assert.deepEqual(outcomeEnd(step, "done"), {
    result: "success",
    reason: "outcome",
    outcome: "done",
  });
  assert.deepEqual(outcomeEnd(step, "nope"), {
    result: "failure",
    reason: "outcome_not_allowed",
    outcome: "nope",
  });
  assert.equal(outcomeEnd(step, "toString").result, "failure");
});

test("the iteration limit fails the attempt", () => {
  assert.deepEqual(ITERATION_LIMIT_END, { result: "failure", reason: "iteration_limit" });
});
