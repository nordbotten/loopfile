import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { AgentStep } from "../domain/model.ts";
import { classifyAgentEnd, reportedOutcome } from "./agent-step.ts";

function step(on: Record<string, string>): AgentStep {
  return {
    id: "work",
    kind: "agent",
    harness: "claude",
    promptFile: "p.md",
    args: [],
    on,
    onFailure: "$failure",
    outputs: {},
    maxAttempts: 5,
    timeoutMs: 1000,
  };
}

const clean = { kind: "exited", code: 0 } as const;

test("a clean exit with an outcome in on succeeds on it", () => {
  assert.deepEqual(classifyAgentEnd(step({ done: "$success" }), clean, "done"), {
    exit: clean,
    outcome: "done",
    result: "success",
    reason: "outcome",
  });
});

test("an outcome that is not a key of on fails, and a prototype name is not a key", () => {
  for (const outcome of ["other", "constructor"]) {
    const end = classifyAgentEnd(step({ done: "$success" }), clean, outcome);
    assert.equal(end.result, "failure");
    assert.equal(end.reason, "outcome_not_allowed");
    assert.equal(end.outcome, outcome);
  }
});

test("a clean exit with no outcome fails when the step has on", () => {
  const end = classifyAgentEnd(step({ done: "$success" }), clean, undefined);
  assert.deepEqual(end, { exit: clean, result: "failure", reason: "clean_exit" });
});

test("a clean exit with no outcome succeeds when the step has no on", () => {
  const end = classifyAgentEnd(step({}), clean, undefined);
  assert.deepEqual(end, { exit: clean, result: "success", reason: "clean_exit" });
});

test("a non-zero exit or a signal fails and keeps the outcome apart", () => {
  const code = { kind: "exited", code: 2 } as const;
  assert.deepEqual(classifyAgentEnd(step({ done: "$success" }), code, "done"), {
    exit: code,
    outcome: "done",
    result: "failure",
    reason: "nonzero_exit",
  });
  const signalled = { kind: "signalled", signal: "SIGKILL" } as const;
  assert.equal(classifyAgentEnd(step({}), signalled, undefined).reason, "nonzero_exit");
});

test("reportedOutcome reads this attempt's last report only", () => {
  const event = (attemptId: string, outcome: string) =>
    ({ type: "outcome.reported", attemptId, outcome, seq: 1, at: "t" }) as unknown as RunEvent;
  const history = [event("001-work", "a"), event("002-work", "x"), event("001-work", "b")];
  assert.equal(reportedOutcome(history, "001-work"), "b");
  assert.equal(reportedOutcome(history, "003-work"), undefined);
  assert.equal(reportedOutcome([], "001-work"), undefined);
});
