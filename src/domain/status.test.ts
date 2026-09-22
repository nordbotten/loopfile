import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUN_LIFECYCLE_STATES,
  STATUS_END_REASONS,
  STATUS_FORMAT_VERSION,
  type StatusProjection,
  TRANSITION_CAUSES,
} from "./status.ts";

/**
 * A running example with a harness in progress, used by this file and by
 * `../application/status.test.ts`. Every field is present, and the metrics
 * the harness has not reported yet are `null`, never left out (ADR 0007).
 */
export const runningExample: StatusProjection = {
  formatVersion: STATUS_FORMAT_VERSION,
  seq: 12,
  updatedAt: "2026-09-18T10:04:00.000Z",
  runId: "2026-09-18-0001",
  loopfileName: "implement",
  state: "running",
  endReason: null,
  startedAt: "2026-09-18T10:00:00.000Z",
  endedAt: null,
  current: {
    stepId: "implement",
    stepKind: "ralph",
    attemptId: "002-implement",
    attempt: 2,
    maxAttempts: 6,
    iteration: 4,
    maxIterations: 20,
    harness: "claude",
    startedAt: "2026-09-18T10:03:00.000Z",
  },
  lastActivityAt: "2026-09-18T10:03:58.000Z",
  lastProgress: "edit src/x.ts",
  visitedSteps: [{ stepId: "implement", attempts: 2 }],
  lastTransition: {
    from: "test",
    to: "implement",
    cause: "on",
    outcome: "failed",
  },
  transitions: 5,
  maxTransitions: 40,
  metrics: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    toolCalls: null,
  },
};

/** A finished run: no current attempt, every metric reported, including `0`. */
export const completedExample: StatusProjection = {
  ...runningExample,
  seq: 40,
  state: "completed",
  endReason: "success",
  endedAt: "2026-09-18T10:20:00.000Z",
  current: null,
  lastTransition: {
    from: "review",
    to: "$success",
    cause: "on",
    outcome: "approved",
  },
  transitions: 8,
  metrics: {
    inputTokens: 4200,
    outputTokens: 900,
    totalTokens: 5100,
    costUsd: 0,
    toolCalls: 0,
  },
};

test("RUN_LIFECYCLE_STATES has no waiting state: v1 has no step kind that waits", () => {
  assert.deepEqual([...RUN_LIFECYCLE_STATES].sort(), [
    "cancelled",
    "completed",
    "failed",
    "running",
  ]);
});

test("RUN_LIFECYCLE_STATES never includes crashed or unknown: a reader derives those (ADR 0007)", () => {
  assert.ok(!RUN_LIFECYCLE_STATES.has("crashed"));
  assert.ok(!RUN_LIFECYCLE_STATES.has("unknown"));
});

test("STATUS_END_REASONS covers every run end reason plus cancelled", () => {
  assert.deepEqual(
    [...STATUS_END_REASONS].sort(),
    [
      "attempt_limit",
      "cancelled",
      "failure",
      "internal_error",
      "run_timeout",
      "success",
      "transition_limit",
    ].sort(),
  );
});

test("TRANSITION_CAUSES is exactly on, onFailure and next", () => {
  assert.deepEqual([...TRANSITION_CAUSES].sort(), ["next", "on", "onFailure"].sort());
});

test("current.harness is null for a command step, which calls no harness", () => {
  const commandCurrent: StatusProjection = {
    ...runningExample,
    current: {
      stepId: "test",
      stepKind: "command",
      attemptId: "003-test",
      attempt: 1,
      maxAttempts: 5,
      iteration: null,
      maxIterations: null,
      harness: null,
      startedAt: "2026-09-18T10:03:00.000Z",
    },
  };
  assert.equal(commandCurrent.current?.harness, null);
});
