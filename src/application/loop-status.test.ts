import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCreated, LoopEnded, LoopEndReason, LoopEvent } from "../domain/events.ts";
import { LOOP_STATUS_FORMAT_VERSION } from "../domain/status.ts";
import { loopStatus } from "./loop-status.ts";

const createdList: LoopCreated = {
  seq: 1,
  at: "2026-09-22T10:00:00.000Z",
  type: "loop.created",
  loopId: "loop-20260922-100000-abcd",
  eventFormatVersion: 1,
  repositoryPath: "/repo",
  loopfileName: "review",
  source: { kind: "list", sets: [{ issue: "41" }, { issue: "42" }] },
  fixedInputs: { project: "loopfile" },
  retry: 2,
  maxRuns: 10,
  pauseMs: 5000,
  program: { version: "0.1.0", digest: "sha256:program" },
};

test("loopStatus folds every status field from a list loop", () => {
  const events: LoopEvent[] = [
    createdList,
    { seq: 2, at: "2026-09-22T10:00:01.000Z", type: "owner.started", pid: 42, host: "box" },
    {
      seq: 3,
      at: "2026-09-22T10:01:00.000Z",
      type: "loop.paused",
      until: "2026-09-22T10:02:00.000Z",
    },
    {
      seq: 4,
      at: "2026-09-22T10:02:00.000Z",
      type: "loop.run_started",
      runId: "run-one",
      index: 1,
      inputSet: { project: "loopfile", issue: "41" },
      sourceIndex: 2,
      retryOf: null,
    },
    {
      seq: 5,
      at: "2026-09-22T10:03:00.000Z",
      type: "loop.cancel_requested",
      mode: "after_run",
    },
    {
      seq: 6,
      at: "2026-09-22T10:04:00.000Z",
      type: "loop.run_started",
      runId: "run-two",
      index: 2,
      inputSet: { project: "loopfile", issue: "42" },
      sourceIndex: 1,
      retryOf: "run-one",
    },
    {
      seq: 7,
      at: "2026-09-22T10:05:00.000Z",
      type: "loop.paused",
      until: "2026-09-22T10:06:00.000Z",
    },
    {
      seq: 8,
      at: "2026-09-22T10:07:00.000Z",
      type: "loop.ended",
      result: "failure",
      reason: "run_failed",
      detail: "child run failed",
    },
  ];

  assert.equal(loopStatus(events.slice(0, 3)).pausedUntil, "2026-09-22T10:02:00.000Z");
  assert.deepEqual(loopStatus(events), {
    formatVersion: LOOP_STATUS_FORMAT_VERSION,
    seq: 8,
    loopId: "loop-20260922-100000-abcd",
    loopfileName: "review",
    state: "failed",
    source: { kind: "list", count: 2 },
    fixedInputs: { project: "loopfile" },
    retry: 2,
    maxRuns: 10,
    place: 2,
    runs: 2,
    retries: 1,
    lastInputSet: { project: "loopfile", issue: "42" },
    lastSourceIndex: 1,
    lastRetryCount: 1,
    runIds: ["run-one", "run-two"],
    currentRunId: null,
    pausedUntil: null,
    cancelRequested: "after_run",
    endReason: "run_failed",
    cancelMode: null,
    detail: "child run failed",
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: "2026-09-22T10:07:00.000Z",
  });
});

test("a running times loop has its current child and highest source place", () => {
  const status = loopStatus([
    { ...createdList, source: { kind: "times", count: 3 } },
    {
      seq: 2,
      at: "2026-09-22T10:01:00.000Z",
      type: "loop.run_started",
      runId: "run-one",
      index: 1,
      inputSet: {},
      sourceIndex: 3,
      retryOf: null,
    },
  ]);

  assert.equal(status.state, "running");
  assert.deepEqual(status.source, { kind: "times", count: 3 });
  assert.equal(status.place, 3);
  assert.equal(status.currentRunId, "run-one");
  assert.equal(status.pausedUntil, null);
  assert.equal(status.endedAt, null);
});

test("a next loop has no place even after it starts a child", () => {
  const status = loopStatus([
    { ...createdList, source: { kind: "next", command: "next-input" } },
    {
      seq: 2,
      at: "2026-09-22T10:01:00.000Z",
      type: "loop.run_started",
      runId: "run-one",
      index: 1,
      inputSet: {},
      sourceIndex: null,
      retryOf: null,
    },
  ]);

  assert.deepEqual(status.source, { kind: "next", command: "next-input" });
  assert.equal(status.place, null);
});

const endStates: readonly [LoopEndReason, string][] = [
  ["source_empty", "completed"],
  ["max_runs", "completed"],
  ["run_failed", "failed"],
  ["source_failed", "failed"],
  ["cancelled", "cancelled"],
  ["program_changed", "failed"],
  ["internal_error", "failed"],
];

for (const [reason, state] of endStates) {
  test(`loop.ended ${reason} maps to ${state}`, () => {
    const ending: LoopEnded =
      reason === "source_empty" || reason === "max_runs"
        ? { seq: 2, at: "2026-09-22T10:01:00.000Z", type: "loop.ended", result: "success", reason }
        : reason === "cancelled"
          ? {
              seq: 2,
              at: "2026-09-22T10:01:00.000Z",
              type: "loop.ended",
              result: "failure",
              reason,
              cancelMode: "now",
            }
          : reason === "internal_error"
            ? {
                seq: 2,
                at: "2026-09-22T10:01:00.000Z",
                type: "loop.ended",
                result: "failure",
                reason,
                childSeq: null,
              }
            : {
                seq: 2,
                at: "2026-09-22T10:01:00.000Z",
                type: "loop.ended",
                result: "failure",
                reason,
              };

    const status = loopStatus([createdList, ending]);
    assert.equal(status.state, state);
    assert.equal(status.endReason, reason);
    assert.equal(status.currentRunId, null);
    assert.equal(status.pausedUntil, null);
    assert.equal(status.cancelMode, reason === "cancelled" ? "now" : null);
    if (reason === "cancelled") {
      assert.equal(
        loopStatus([
          createdList,
          { seq: 2, at: "2026-09-22T10:01:00.000Z", type: "loop.ended", result: "failure", reason },
        ]).cancelMode,
        null,
      );
    }
  });
}

test("owner.started clears an internal-error end to resume the loop", () => {
  const status = loopStatus([
    createdList,
    {
      seq: 2,
      at: "2026-09-22T10:01:00.000Z",
      type: "loop.run_started",
      runId: "run-one",
      index: 1,
      inputSet: {},
      sourceIndex: 1,
      retryOf: null,
    },
    {
      seq: 3,
      at: "2026-09-22T10:02:00.000Z",
      type: "loop.ended",
      result: "failure",
      reason: "internal_error",
      detail: "driver failed",
      childSeq: 4,
    },
    { seq: 4, at: "2026-09-22T10:03:00.000Z", type: "owner.started", pid: 42, host: "box" },
  ]);

  assert.equal(status.state, "running");
  assert.equal(status.endReason, null);
  assert.equal(status.detail, null);
  assert.equal(status.endedAt, null);
  assert.equal(status.currentRunId, "run-one");
});

test("owner.started does not reopen a normally ended loop", () => {
  const status = loopStatus([
    createdList,
    {
      seq: 2,
      at: "2026-09-22T10:01:00.000Z",
      type: "loop.ended",
      result: "failure",
      reason: "run_failed",
      detail: "child run failed",
    },
    { seq: 3, at: "2026-09-22T10:02:00.000Z", type: "owner.started", pid: 42, host: "box" },
  ]);

  assert.equal(status.state, "failed");
  assert.equal(status.endReason, "run_failed");
  assert.equal(status.detail, "child run failed");
  assert.equal(status.endedAt, "2026-09-22T10:01:00.000Z");
});

test("loopStatus rejects a log without loop.created", () => {
  assert.throws(() => loopStatus([]), /does not start with loop\.created/);
});
