import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandStep } from "../domain/model.ts";
import { checkAttemptLimit } from "./attempt-limit.ts";
import type { RunState } from "./replay.ts";

function step(fields: Partial<CommandStep> = {}): CommandStep {
  return {
    id: "fix",
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

/** Builds a `RunState` whose `attempts` has, for each step, the given number of attempt IDs. */
function state(counts: Record<string, number>): RunState {
  const attempts = Object.fromEntries(
    Object.entries(counts).map(([stepId, count]) => [
      stepId,
      Array.from({ length: count }, (_, index) => `${index + 1}-${stepId}`),
    ]),
  );
  return {
    runId: "run-1",
    modelDigest: "digest",
    attempts,
    transitions: [],
    attemptsSinceContinue: attempts,
    transitionsSinceContinue: [],
    ownerTimeSinceContinueMs: 0,
    ownerTimeMs: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastEventAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a step under its limit may start another attempt", () => {
  assert.deepEqual(checkAttemptLimit(step({ maxAttempts: 5 }), state({ fix: 4 })), {
    allowed: true,
  });
});

test("a step never visited may start its first attempt", () => {
  assert.deepEqual(checkAttemptLimit(step({ maxAttempts: 5 }), state({})), { allowed: true });
});

test("a step whose ID is an Object.prototype name starts with no attempts counted", () => {
  const inherited = step({ id: "constructor", maxAttempts: 1 });
  assert.deepEqual(checkAttemptLimit(inherited, state({})), { allowed: true });
});

test("a step at its limit ends the run in failure, naming the step", () => {
  const limited = step({ id: "implement", maxAttempts: 5 });
  assert.deepEqual(checkAttemptLimit(limited, state({ implement: 5 })), {
    allowed: false,
    event: { type: "run.ended", result: "failure", reason: "attempt_limit", stepId: "implement" },
  });
});

test("a count past the limit is refused too, not just an exact match", () => {
  assert.equal(checkAttemptLimit(step({ maxAttempts: 5 }), state({ fix: 6 })).allowed, false);
});

test("a lower maxAttempts is checked too, not just the default", () => {
  assert.equal(checkAttemptLimit(step({ maxAttempts: 1 }), state({ fix: 1 })).allowed, false);
});
