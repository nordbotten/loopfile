import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopEvent } from "../domain/events.ts";
import { repeatedLoopInternalError } from "./loop-resume.ts";

function internalError(
  childSeq: number | null,
  seq: number,
): Extract<LoopEvent, { type: "loop.ended" }> {
  return {
    seq,
    at: "2026-09-23T12:00:00.000Z",
    type: "loop.ended",
    result: "failure",
    reason: "internal_error",
    childSeq,
  };
}

function runStarted(seq: number): Extract<LoopEvent, { type: "loop.run_started" }> {
  return {
    seq,
    at: "2026-09-23T12:00:00.000Z",
    type: "loop.run_started",
    runId: "run-next",
    index: 2,
    inputSet: {},
    sourceIndex: null,
    retryOf: null,
  };
}

test("loop resume guard detects repeated internal errors only without child progress", () => {
  assert.equal(repeatedLoopInternalError([internalError(7, 2), internalError(7, 3)]), true);
  assert.equal(
    repeatedLoopInternalError([internalError(7, 2), runStarted(3), internalError(7, 4)]),
    false,
  );
  assert.equal(repeatedLoopInternalError([internalError(7, 2), internalError(8, 3)]), false);
  assert.equal(
    repeatedLoopInternalError([internalError(7, 2), internalError(8, 3), internalError(7, 4)]),
    true,
  );
});

test("loop resume guard ignores unrelated ends and only loop ends", () => {
  const unrelatedEnd: LoopEvent = {
    ...internalError(null, 2),
    reason: "source_empty",
    result: "success",
  };
  assert.equal(repeatedLoopInternalError([unrelatedEnd, unrelatedEnd]), false);

  const unrelatedRun = { ...runStarted(3), reason: "internal_error", childSeq: null };
  assert.equal(
    repeatedLoopInternalError([internalError(null, 2), unrelatedRun, internalError(null, 4)]),
    false,
  );
});
