import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopEvent } from "../domain/events.ts";
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

function retryAction(child: LastChild, retry: number, history: readonly LoopEvent[]) {
  return nextLoopAction(status, child, undefined, undefined, undefined, retry, history);
}

function started(
  runId: string,
  inputSet: Record<string, string>,
  sourceIndex: number,
  retryOf: string | null = null,
): Extract<LoopEvent, { type: "loop.run_started" }> {
  return {
    seq: 2,
    at: "2026-09-22T10:00:00.000Z",
    type: "loop.run_started",
    runId,
    index: 1,
    inputSet,
    sourceIndex,
    retryOf,
  };
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

test("starts next runs from the command result and resolves defaults", () => {
  const next: LoopStatus = {
    ...status,
    source: { kind: "next", command: "next-input" },
    fixedInputs: { project: "loopfile" },
    place: null,
  };
  const source = { kind: "next" as const, command: "next-input" };
  assert.deepEqual(
    nextLoopAction(
      next,
      { state: "none" },
      source,
      { kind: "output", result: { ok: true, inputs: { issue: "41" } } },
      {
        inputs: { project: "The project", issue: "The issue number", optional: "Optional" },
        inputDefaults: { optional: "yes" },
      },
    ),
    {
      kind: "start",
      inputSet: { project: "loopfile", issue: "41", optional: "yes" },
      sourceIndex: null,
    },
  );
});

test("ends a next loop when its command result is bad", () => {
  const next: LoopStatus = {
    ...status,
    source: { kind: "next", command: "next-input" },
    place: null,
  };
  const source = { kind: "next" as const, command: "next-input" };
  assert.deepEqual(
    nextLoopAction(
      next,
      { state: "none" },
      source,
      { kind: "output", result: { ok: false, messages: ['input "issue" is not a string'] } },
      { inputs: { issue: "The issue number" } },
    ),
    {
      kind: "end",
      reason: "source_failed",
      detail: 'input "issue" is not a string',
    },
  );
  assert.deepEqual(
    nextLoopAction(next, { state: "none" }, source, { kind: "empty" }, { inputs: {} }),
    { kind: "end", reason: "source_empty" },
  );
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

test("retries a failed child with the same input set and source place", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-one" }, 1, [
      started("run-one", { project: "loopfile" }, 1),
    ]),
    {
      kind: "start",
      inputSet: { project: "loopfile" },
      sourceIndex: 1,
      retryOf: "run-one",
    },
  );
});

test("ends when a failed child has used its retries", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-two" }, 1, [
      started("run-one", { project: "loopfile" }, 1),
      started("run-two", { project: "loopfile" }, 1, "run-one"),
    ]),
    { kind: "end", reason: "run_failed", detail: "run run-two failed" },
  );
});

test("counts the full retry chain", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-two" }, 2, [
      started("run-one", { project: "loopfile" }, 1),
      started("run-two", { project: "loopfile" }, 1, "run-one"),
    ]),
    {
      kind: "start",
      inputSet: { project: "loopfile" },
      sourceIndex: 1,
      retryOf: "run-two",
    },
  );
});

test("does not retry a child that is absent from history", () => {
  assert.deepEqual(retryAction({ state: "failed", runId: "missing" }, 1, []), {
    kind: "end",
    reason: "run_failed",
    detail: "run missing failed",
  });
});

test("does not fail when a retry parent is absent from history", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-one" }, 2, [
      started("run-one", { project: "loopfile" }, 1, "missing"),
    ]),
    {
      kind: "start",
      inputSet: { project: "loopfile" },
      sourceIndex: 1,
      retryOf: "run-one",
    },
  );
});

test("counts retries independently for each input set", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-b" }, 1, [
      started("run-a", { issue: "a" }, 1),
      started("run-a-retry", { issue: "a" }, 1, "run-a"),
      started("run-b", { issue: "b" }, 2),
    ]),
    {
      kind: "start",
      inputSet: { issue: "b" },
      sourceIndex: 2,
      retryOf: "run-b",
    },
  );
});

test("a cancelled child is never retried", () => {
  assert.deepEqual(
    retryAction({ state: "cancelled", runId: "run-one" }, 1, [
      started("run-one", { project: "loopfile" }, 1),
    ]),
    { kind: "end", reason: "run_failed", detail: "run run-one cancelled" },
  );
});

test("ends when a child owner has crashed", () => {
  assert.deepEqual(action({ state: "crashed", runId: "run-one" }), {
    kind: "end",
    reason: "internal_error",
    detail: "child run run-one crashed",
  });
});
