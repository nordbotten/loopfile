import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopEvent } from "../domain/events.ts";
import type { LoopStatus } from "../domain/status.ts";
import { type LastChild, nextLoopAction } from "./next-loop-action.ts";

const pauseOptions = { pauseMs: 1000, now: new Date("2026-09-22T10:00:00.000Z") };

const status: LoopStatus = {
  formatVersion: 1,
  seq: 4,
  loopId: "loop-20260922-100000-abcd",
  loopfileName: "review",
  state: "running",
  source: { kind: "times", count: 3 },
  fixedInputs: { project: "loopfile" },
  retry: 0,
  maxRuns: null,
  place: 1,
  runs: 1,
  retries: 0,
  lastInputSet: { project: "loopfile" },
  lastSourceIndex: 1,
  lastRetryCount: 0,
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

function retryAction(child: LastChild, history: readonly LoopEvent[], retry = 1) {
  return nextLoopAction({ ...status, retry }, child, undefined, undefined, undefined, history);
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
    undefined,
    undefined,
    undefined,
    [],
    pauseOptions,
  );
  assert.deepEqual(first, {
    kind: "start",
    inputSet: { project: "loopfile" },
    sourceIndex: 1,
  });
});

test("pauses before the second and later runs", () => {
  assert.deepEqual(
    nextLoopAction(
      status,
      { state: "completed", runId: "run-one" },
      undefined,
      undefined,
      undefined,
      [],
      pauseOptions,
    ),
    { kind: "pause", until: "2026-09-22T10:00:01.000Z" },
  );
  assert.deepEqual(
    nextLoopAction(
      { ...status, place: 2, runs: 2, pausedUntil: "2026-09-22T10:00:01.000Z" },
      { state: "completed", runId: "run-two" },
      undefined,
      undefined,
      undefined,
      [],
      pauseOptions,
    ),
    { kind: "start", inputSet: { project: "loopfile" }, sourceIndex: 3 },
  );
});

test("starts the next run after a completed child", () => {
  assert.deepEqual(action({ state: "completed", runId: "run-one" }), {
    kind: "start",
    inputSet: { project: "loopfile" },
    sourceIndex: 2,
  });
});

test("ends well instead of starting when max runs is reached", () => {
  assert.deepEqual(
    nextLoopAction(
      { ...status, runs: 2, maxRuns: 2 },
      { state: "completed", runId: "run-one" },
      undefined,
      undefined,
      undefined,
      [],
      pauseOptions,
    ),
    { kind: "end", reason: "max_runs" },
  );
});

test("does not need a next command result when max runs is reached", () => {
  assert.deepEqual(
    nextLoopAction(
      { ...status, source: { kind: "next", command: "next-input" }, maxRuns: 1, runs: 1 },
      { state: "completed", runId: "run-one" },
      { kind: "next", command: "next-input" },
      { kind: "output", result: { ok: true, inputs: { issue: "41" } } },
    ),
    { kind: "end", reason: "max_runs" },
  );
});

test("pauses before a retry", () => {
  assert.deepEqual(
    nextLoopAction(
      { ...status, retry: 1, lastRetryCount: 0 },
      { state: "failed", runId: "run-one" },
      undefined,
      undefined,
      undefined,
      [started("run-one", { project: "loopfile" }, 1)],
      pauseOptions,
    ),
    { kind: "pause", until: "2026-09-22T10:00:01.000Z" },
  );
});

test("allows a failed run's retry with the same input", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-one" }, [
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

test("ends a failed run when its retries are used up", () => {
  assert.deepEqual(
    retryAction(
      { state: "failed", runId: "run-two" },
      [
        started("run-one", { project: "loopfile" }, 1),
        started("run-two", { project: "loopfile" }, 1, "run-one"),
      ],
      1,
    ),
    { kind: "end", reason: "run_failed", detail: "run run-two failed" },
  );
});

test("counts the retry chain per input set", () => {
  assert.deepEqual(
    retryAction({ state: "failed", runId: "run-b" }, [
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

test("counts every retry in the chain", () => {
  assert.deepEqual(
    retryAction(
      { state: "failed", runId: "run-two" },
      [
        started("run-one", { project: "loopfile" }, 1),
        started("run-two", { project: "loopfile" }, 1, "run-one"),
      ],
      2,
    ),
    {
      kind: "start",
      inputSet: { project: "loopfile" },
      sourceIndex: 1,
      retryOf: "run-two",
    },
  );
});

test("does not retry a failed child absent from history", () => {
  assert.deepEqual(retryAction({ state: "failed", runId: "missing" }, []), {
    kind: "end",
    reason: "run_failed",
    detail: "run missing failed",
  });
});

test("counts a retry whose parent is absent", () => {
  assert.deepEqual(
    retryAction(
      { state: "failed", runId: "run-one" },
      [started("run-one", { project: "loopfile" }, 1, "missing")],
      2,
    ),
    {
      kind: "start",
      inputSet: { project: "loopfile" },
      sourceIndex: 1,
      retryOf: "run-one",
    },
  );
});

test("max runs stops a retry", () => {
  assert.deepEqual(
    nextLoopAction(
      { ...status, retry: 1, maxRuns: 1, runs: 1, lastRetryCount: 0 },
      { state: "failed", runId: "run-one" },
      undefined,
      undefined,
      undefined,
      [started("run-one", { project: "loopfile" }, 1)],
    ),
    { kind: "end", reason: "max_runs" },
  );
});

test("a failed run with no retries left ends the loop", () => {
  assert.deepEqual(action({ state: "failed", runId: "run-one" }), {
    kind: "end",
    reason: "run_failed",
    detail: "run run-one failed",
  });
});

test("does not retry a cancelled child", () => {
  assert.deepEqual(
    nextLoopAction({ ...status, retry: 1 }, { state: "cancelled", runId: "run-one" }),
    { kind: "end", reason: "run_failed", detail: "run run-one cancelled" },
  );
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

test("pauses before asking --next for another input set", () => {
  const next: LoopStatus = {
    ...status,
    source: { kind: "next", command: "next-input" },
    place: null,
  };
  assert.deepEqual(
    nextLoopAction(
      next,
      { state: "completed", runId: "run-one" },
      { kind: "next", command: "next-input" },
      undefined,
      undefined,
      [],
      pauseOptions,
    ),
    { kind: "pause", until: "2026-09-22T10:00:01.000Z" },
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
  assert.deepEqual(
    nextLoopAction(next, { state: "none" }, source, undefined, undefined, [], { pauseMs: null }),
    { kind: "end", reason: "source_failed", detail: "--next did not produce a result" },
  );
  assert.deepEqual(
    nextLoopAction(
      next,
      { state: "none" },
      source,
      { kind: "output", result: { ok: true, inputs: { project: "other" } } },
      { inputs: { project: "The project" } },
    ),
    {
      kind: "end",
      reason: "source_failed",
      detail: 'input "project" is given by both --input and the input source',
    },
  );
  assert.deepEqual(
    nextLoopAction(
      { ...next, fixedInputs: {} },
      { state: "none" },
      source,
      { kind: "output", result: { ok: true, inputs: { extra: "value" } } },
      { inputs: { issue: "The issue number" } },
    ),
    {
      kind: "end",
      reason: "source_failed",
      detail: "--input extra is not declared by the Loopfile. Declared inputs: issue.",
    },
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
    nextLoopAction(
      { ...status, place: 3 },
      { state: "completed", runId: "run-three" },
      undefined,
      undefined,
      undefined,
      [],
      pauseOptions,
    ),
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
