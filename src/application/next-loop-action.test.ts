import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopStatus } from "../domain/status.ts";
import { type LastChild, nextLoopAction } from "./next-loop-action.ts";

const status: LoopStatus = {
  formatVersion: 1,
  seq: 4,
  loopId: "loop-20260922-100000-abcd",
  loopfileName: "review",
  state: "running",
  source: { kind: "times", count: 3 },
  fixedInputs: { project: "loopfile" },
  place: 1,
  runs: 1,
  retries: 0,
  runIds: ["run-one"],
  currentRunId: "run-one",
  pausedUntil: null,
  cancelRequested: null,
  endReason: null,
  cancelMode: null,
  detail: null,
  startedAt: "2026-09-22T10:00:00.000Z",
  endedAt: null,
};

function action(child: LastChild) {
  return nextLoopAction(status, child);
}

test("starts the first run with fixed inputs", () => {
  const first = nextLoopAction(
    { ...status, place: 0, runs: 0, runIds: [], currentRunId: null },
    { state: "none" },
  );
  assert.deepEqual(first, {
    kind: "start",
    inputSet: { project: "loopfile" },
    sourceIndex: 1,
  });
});

test("starts the next run after a completed child", () => {
  assert.deepEqual(action({ state: "completed", runId: "run-one" }), {
    kind: "start",
    inputSet: { project: "loopfile" },
    sourceIndex: 2,
  });
});

test("starts list runs with the source set merged into fixed inputs", () => {
  const list: LoopStatus = { ...status, source: { kind: "list", count: 2 }, place: 0 };
  assert.deepEqual(
    nextLoopAction(
      list,
      { state: "none" },
      { kind: "list", sets: [{ issue: "41" }, { issue: "42" }] },
    ),
    {
      kind: "start",
      inputSet: { project: "loopfile", issue: "41" },
      sourceIndex: 1,
    },
  );
  assert.deepEqual(
    nextLoopAction(
      { ...list, place: 1 },
      { state: "completed", runId: "run-one" },
      { kind: "list", sets: [{ issue: "41" }, { issue: "42" }] },
    ),
    {
      kind: "start",
      inputSet: { project: "loopfile", issue: "42" },
      sourceIndex: 2,
    },
  );
});

test("ends when the source is empty", () => {
  assert.deepEqual(
    nextLoopAction({ ...status, place: 3 }, { state: "completed", runId: "run-three" }),
    { kind: "end", reason: "source_empty" },
  );
  assert.deepEqual(nextLoopAction({ ...status, place: 3 }, { state: "none" }), {
    kind: "end",
    reason: "source_empty",
  });
});

test("waits for a running child", () => {
  assert.deepEqual(action({ state: "running", runId: "run-one" }), { kind: "wait" });
});

test("ends on a failed or cancelled child", () => {
  for (const state of ["failed", "cancelled"] as const) {
    assert.deepEqual(action({ state, runId: "run-one" }), {
      kind: "end",
      reason: "run_failed",
      detail: `run run-one ${state}`,
    });
  }
});

test("ends when a child owner has crashed", () => {
  assert.deepEqual(action({ state: "crashed", runId: "run-one" }), {
    kind: "end",
    reason: "internal_error",
    detail: "child run run-one crashed",
  });
});
