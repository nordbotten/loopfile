import assert from "node:assert/strict";
import { test } from "node:test";
import { completedExample, runningExample } from "../domain/status.test.ts";
import { InvalidStatusProjectionError, parseStatusProjection } from "./status.ts";

/** Round-trips a valid example through JSON, the shape a reader actually gets. */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("parses a running example", () => {
  assert.deepEqual(parseStatusProjection(roundTrip(runningExample)), runningExample);
});

test("parses a completed example with every metric reported, including 0", () => {
  const parsed = parseStatusProjection(roundTrip(completedExample));
  assert.deepEqual(parsed, completedExample);
  assert.equal(parsed.metrics.costUsd, 0);
  assert.equal(parsed.metrics.toolCalls, 0);
});

test("reads a status.json without permissionDenials as unknown", () => {
  const value = roundTrip(runningExample) as Record<string, unknown>;
  delete (value.metrics as Record<string, unknown>).permissionDenials;
  const parsed = parseStatusProjection(value);
  assert.equal(parsed.metrics.permissionDenials, null);
});

test("rejects a value that is not an object", () => {
  assert.throws(() => parseStatusProjection("not json"), InvalidStatusProjectionError);
  assert.throws(() => parseStatusProjection(null), InvalidStatusProjectionError);
  assert.throws(() => parseStatusProjection([]), InvalidStatusProjectionError);
});

test("rejects a formatVersion other than 1", () => {
  const value = { ...(roundTrip(runningExample) as Record<string, unknown>), formatVersion: 2 };
  assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
});

test("rejects a state outside the four documented values", () => {
  const value = { ...(roundTrip(runningExample) as Record<string, unknown>), state: "waiting" };
  assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
});

test("passes an unknown endReason through", () => {
  const value = {
    ...(roundTrip(completedExample) as Record<string, unknown>),
    endReason: "internal_error",
  };
  const parsed = parseStatusProjection(value);
  assert.equal(parsed.endReason, "internal_error");
});

/** Every top-level field is required (ADR 0007): missing any one fails the schema. */
const topLevelFields = [
  "formatVersion",
  "seq",
  "updatedAt",
  "runId",
  "loopfileName",
  "state",
  "endReason",
  "startedAt",
  "endedAt",
  "current",
  "lastActivityAt",
  "lastProgress",
  "visitedSteps",
  "lastTransition",
  "transitions",
  "maxTransitions",
  "metrics",
];

for (const field of topLevelFields) {
  test(`rejects a status.json missing ${field}`, () => {
    const value = roundTrip(runningExample) as Record<string, unknown>;
    delete value[field];
    assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
  });
}

/** Every field of `current` is required too, when `current` is not null. */
const currentFields = [
  "stepId",
  "stepKind",
  "attemptId",
  "attempt",
  "maxAttempts",
  "iteration",
  "maxIterations",
  "harness",
  "startedAt",
];

for (const field of currentFields) {
  test(`rejects a status.json missing current.${field}`, () => {
    const value = roundTrip(runningExample) as Record<string, unknown>;
    delete (value.current as Record<string, unknown>)[field];
    assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
  });
}

/** Existing fields of `metrics` are required, `null` or a number, never missing. */
const metricsFields = ["inputTokens", "outputTokens", "totalTokens", "costUsd", "toolCalls"];

for (const field of metricsFields) {
  test(`rejects a status.json missing metrics.${field}`, () => {
    const value = roundTrip(runningExample) as Record<string, unknown>;
    delete (value.metrics as Record<string, unknown>)[field];
    assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
  });
}

test("accepts current: null when no attempt is running", () => {
  const value = { ...(roundTrip(runningExample) as Record<string, unknown>), current: null };
  const parsed = parseStatusProjection(value);
  assert.equal(parsed.current, null);
});

test("accepts endReason, endedAt and lastTransition.outcome as null while a run is running", () => {
  const parsed = parseStatusProjection(roundTrip(runningExample));
  assert.equal(parsed.endReason, null);
  assert.equal(parsed.endedAt, null);
});

test("rejects a metrics field that is a string instead of null or a number", () => {
  const value = roundTrip(runningExample) as Record<string, unknown>;
  (value.metrics as Record<string, unknown>).costUsd = "12.50";
  assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
});

test("rejects a visitedSteps entry missing attempts", () => {
  const value = roundTrip(runningExample) as Record<string, unknown>;
  value.visitedSteps = [{ stepId: "implement" }];
  assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
});

test("rejects a lastTransition missing cause", () => {
  const value = roundTrip(completedExample) as Record<string, unknown>;
  delete (value.lastTransition as Record<string, unknown>).cause;
  assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
});

test("rejects a lastTransition.cause outside on, onFailure and next", () => {
  const value = roundTrip(completedExample) as Record<string, unknown>;
  (value.lastTransition as Record<string, unknown>).cause = "manual";
  assert.throws(() => parseStatusProjection(value), InvalidStatusProjectionError);
});
