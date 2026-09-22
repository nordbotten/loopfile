import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import { STATUS_FORMAT_VERSION } from "../domain/status.ts";
import {
  type HarnessData,
  NO_HARNESS_DATA,
  type ProjectStatusContext,
  projectStatus,
  UNKNOWN_METRICS,
} from "./status-projection.ts";

/** Minutes past 10:00 on one day, so a log reads as a timeline. */
function at(minute: number, second = 0): string {
  return new Date(Date.UTC(2026, 8, 18, 10, minute, second)).toISOString();
}

/** One event as a test writes it: everything but `seq`, which `events` numbers in order. */
type EventWithoutSeq = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "seq">
    : never
  : never;

/** A hand-written event, numbered in call order so a test says only what it is about. */
function events(...partials: readonly EventWithoutSeq[]): RunEvent[] {
  return partials.map((event, index) => ({ ...event, seq: index + 1 }) as RunEvent);
}

const workflow: Workflow = {
  formatVersion: 1,
  inputs: {},
  maxTransitions: 40,
  steps: [
    {
      id: "plan",
      kind: "agent",
      harness: "claude",
      promptFile: "plan.md",
      args: [],
      on: { ready: "implement" },
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 5,
      timeoutMs: 3_600_000,
    },
    {
      id: "implement",
      kind: "ralph",
      harness: "claude",
      promptFile: "implement.md",
      args: [],
      maxIterations: 20,
      on: { done: "$success" },
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 6,
      timeoutMs: 3_600_000,
    },
    {
      id: "build",
      kind: "command",
      run: "npm run build",
      on: {},
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 3,
      timeoutMs: 3_600_000,
    },
  ],
};

const created: EventWithoutSeq = {
  type: "run.created",
  at: at(0),
  runId: "r-1",
  eventFormatVersion: 1,
  modelDigest: "sha256:model",
  repositoryPath: "/home/me/project",
  baseCommit: "9f1c0de",
  branch: "loopfile/r-1",
  inputs: [],
};

function context(overrides: Partial<ProjectStatusContext> = {}): ProjectStatusContext {
  return { workflow, loopfileName: "implement", updatedAt: at(5), ...overrides };
}

test("a fresh run with only run.created is running, with no current attempt", () => {
  const log = events(created);
  const status = projectStatus(log, context());

  assert.equal(status.formatVersion, STATUS_FORMAT_VERSION);
  assert.equal(status.seq, 1);
  assert.equal(status.runId, "r-1");
  assert.equal(status.loopfileName, "implement");
  assert.equal(status.state, "running");
  assert.equal(status.endReason, null);
  assert.equal(status.startedAt, at(0));
  assert.equal(status.endedAt, null);
  assert.equal(status.current, null);
  assert.equal(status.transitions, 0);
  assert.equal(status.maxTransitions, 40);
  assert.deepEqual(status.visitedSteps, []);
  assert.equal(status.lastTransition, null);
  assert.deepEqual(status.metrics, UNKNOWN_METRICS);
});

test("an open attempt on an agent step fills current from the workflow", () => {
  const log = events(created, {
    type: "attempt.started",
    at: at(1),
    attemptId: "001-plan",
    stepId: "plan",
    processGroupId: 1,
  });
  const status = projectStatus(log, context());

  assert.deepEqual(status.current, {
    stepId: "plan",
    stepKind: "agent",
    attemptId: "001-plan",
    attempt: 1,
    maxAttempts: 5,
    iteration: null,
    maxIterations: null,
    harness: "claude",
    startedAt: at(1),
  });
});

test("a command step's current attempt has no harness and no iteration", () => {
  const log = events(created, {
    type: "attempt.started",
    at: at(1),
    attemptId: "001-build",
    stepId: "build",
    processGroupId: 1,
  });
  const status = projectStatus(log, context());

  assert.equal(status.current?.stepKind, "command");
  assert.equal(status.current?.harness, null);
  assert.equal(status.current?.iteration, null);
  assert.equal(status.current?.maxIterations, null);
});

test("a ralph step's iteration counts iteration.started events on the open attempt", () => {
  const log = events(
    created,
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "002-implement",
      stepId: "implement",
      processGroupId: 1,
    },
    {
      type: "iteration.started",
      at: at(1, 5),
      attemptId: "002-implement",
      iteration: 1,
      processGroupId: 9,
    },
    {
      type: "iteration.ended",
      at: at(1, 30),
      attemptId: "002-implement",
      iteration: 1,
      reason: "no_outcome",
    },
    {
      type: "iteration.started",
      at: at(1, 31),
      attemptId: "002-implement",
      iteration: 2,
      processGroupId: 9,
    },
  );
  const status = projectStatus(log, context());

  assert.equal(status.current?.stepKind, "ralph");
  assert.equal(status.current?.iteration, 2);
  assert.equal(status.current?.maxIterations, 20);
});

test("current is null between an attempt's end and the next one's start", () => {
  const log = events(
    created,
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "001-plan",
      stepId: "plan",
      processGroupId: 1,
    },
    {
      type: "attempt.ended",
      at: at(2),
      attemptId: "001-plan",
      result: "success",
      reason: "outcome",
      outcome: "ready",
    },
  );
  const status = projectStatus(log, context());

  assert.equal(status.current, null);
});

test("current.attempt counts this step's own attempts, not the run's", () => {
  const log = events(
    created,
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "001-plan",
      stepId: "plan",
      processGroupId: 1,
    },
    {
      type: "attempt.ended",
      at: at(2),
      attemptId: "001-plan",
      result: "failure",
      reason: "nonzero_exit",
    },
    {
      type: "attempt.started",
      at: at(3),
      attemptId: "002-plan",
      stepId: "plan",
      processGroupId: 2,
    },
  );
  const status = projectStatus(log, context());

  assert.equal(status.current?.attempt, 2);
  assert.equal(status.current?.attemptId, "002-plan");
});

test("an interrupted attempt closes current the same as a clean end", () => {
  const log = events(
    created,
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "001-plan",
      stepId: "plan",
      processGroupId: 1,
    },
    { type: "attempt.interrupted", at: at(2), attemptId: "001-plan" },
  );
  const status = projectStatus(log, context());

  assert.equal(status.current, null);
});

test("visitedSteps lists every step with an attempt, oldest visited first", () => {
  const log = events(
    created,
    {
      type: "attempt.started",
      at: at(1),
      attemptId: "001-plan",
      stepId: "plan",
      processGroupId: 1,
    },
    {
      type: "attempt.ended",
      at: at(2),
      attemptId: "001-plan",
      result: "success",
      reason: "outcome",
      outcome: "ready",
    },
    {
      type: "transition",
      at: at(2),
      from: "plan",
      attemptId: "001-plan",
      result: "success",
      reason: "outcome",
      outcome: "ready",
      to: "implement",
      cause: "on",
    },
    {
      type: "attempt.started",
      at: at(3),
      attemptId: "002-implement",
      stepId: "implement",
      processGroupId: 2,
    },
  );
  const status = projectStatus(log, context());

  assert.deepEqual(status.visitedSteps, [
    { stepId: "plan", attempts: 1 },
    { stepId: "implement", attempts: 1 },
  ]);
  assert.deepEqual(status.lastTransition, {
    from: "plan",
    to: "implement",
    cause: "on",
    outcome: "ready",
  });
  assert.equal(status.transitions, 1);
});

test("a transition with no outcome (onFailure or next) reports outcome null", () => {
  const log = events(created, {
    type: "transition",
    at: at(1),
    from: "plan",
    attemptId: "001-plan",
    result: "failure",
    reason: "nonzero_exit",
    to: "$failure",
    cause: "onFailure",
  });
  const status = projectStatus(log, context());

  assert.deepEqual(status.lastTransition, {
    from: "plan",
    to: "$failure",
    cause: "onFailure",
    outcome: null,
  });
});

test("a run ended with end_state reports the result as the status end reason", () => {
  const log = events(created, {
    type: "run.ended",
    at: at(10),
    result: "success",
    reason: "end_state",
  });
  const status = projectStatus(log, context());

  assert.equal(status.state, "completed");
  assert.equal(status.endReason, "success");
  assert.equal(status.endedAt, at(10));
  assert.equal(status.current, null);
});

test("a run that fails reports the failed state, whatever its own end reason", () => {
  const log = events(created, {
    type: "run.ended",
    at: at(10),
    result: "failure",
    reason: "end_state",
  });
  const status = projectStatus(log, context());

  assert.equal(status.state, "failed");
  assert.equal(status.endReason, "failure");
});

test("a run ended by a limit reports that limit as the end reason, not success or failure", () => {
  const log = events(created, {
    type: "run.ended",
    at: at(10),
    result: "failure",
    reason: "attempt_limit",
    stepId: "plan",
  });
  const status = projectStatus(log, context());

  assert.equal(status.state, "failed");
  assert.equal(status.endReason, "attempt_limit");
});

test("a cancelled run reports state and end reason cancelled", () => {
  const log = events(created, { type: "run.cancelled", at: at(10) });
  const status = projectStatus(log, context());

  assert.equal(status.state, "cancelled");
  assert.equal(status.endReason, "cancelled");
  assert.equal(status.endedAt, at(10));
});

test("lastActivityAt falls back to the last event's time when the harness has reported nothing", () => {
  const log = events(created);
  const status = projectStatus(log, context(), NO_HARNESS_DATA);

  assert.equal(status.lastActivityAt, at(0));
  assert.equal(status.lastProgress, null);
});

test("lastActivityAt, lastProgress and metrics come from the harness data when it has some", () => {
  const log = events(created);
  const harnessData: HarnessData = {
    lastActivityAt: at(4),
    lastProgress: "edit src/x.ts",
    metrics: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01, toolCalls: 1 },
  };
  const status = projectStatus(log, context(), harnessData);

  assert.equal(status.lastActivityAt, at(4));
  assert.equal(status.lastProgress, "edit src/x.ts");
  assert.deepEqual(status.metrics, harnessData.metrics);
});

test("seq is the last event's own seq, whatever the event type", () => {
  const log = events(created, { type: "owner.started", at: at(1), pid: 1, host: "box" });
  const status = projectStatus(log, context());

  assert.equal(status.seq, 2);
});

test("a step not in the workflow gets maxAttempts 0 and stepKind command rather than throwing", () => {
  const log = events(created, {
    type: "attempt.started",
    at: at(1),
    attemptId: "001-ghost",
    stepId: "ghost",
    processGroupId: 1,
  });
  const status = projectStatus(log, context());

  assert.equal(status.current?.stepKind, "command");
  assert.equal(status.current?.maxAttempts, 0);
  assert.equal(status.current?.harness, null);
});
