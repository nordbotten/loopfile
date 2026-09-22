import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { CommandStep, RalphStep } from "../domain/model.ts";
import { runFacts } from "./run-facts.ts";

const step: CommandStep = {
  id: "work",
  kind: "command",
  run: "true",
  on: {},
  onFailure: "$failure",
  outputs: {},
  maxAttempts: 3,
  timeoutMs: 30_000,
  declaredLimits: { maxAttempts: 3, timeout: "30s" },
};

const ralph: RalphStep = {
  id: "loop",
  kind: "ralph",
  harness: "pi",
  promptFile: "loop.md",
  args: [],
  on: { done: "$success" },
  onFailure: "$failure",
  outputs: {},
  maxAttempts: 5,
  timeoutMs: 30_000,
  maxIterations: 3,
};

const created = {
  type: "run.created",
  runId: "run-1",
  eventFormatVersion: 1,
  modelDigest: "digest",
  repositoryPath: "/repo",
  baseCommit: "base",
  branch: "loopfile/run-1",
  seq: 1,
  at: "created",
} as RunEvent;

const started = (attemptId: string, at: string, stepId = "work"): RunEvent =>
  ({
    type: "attempt.started",
    attemptId,
    stepId,
    processGroupId: 1,
    seq: 1,
    at,
  }) as RunEvent;

test("run facts count this step's visits and expose only declared limits", () => {
  const facts = runFacts(
    [created, started("001-work", "first"), started("002-work", "second")],
    step,
    {
      attemptId: "003-work",
      stepId: "work",
      startedAt: "third",
    },
  );
  assert.deepEqual(facts, {
    runId: "run-1",
    loopfileName: "",
    startedAt: "created",
    repositoryPath: "/repo",
    branch: "loopfile/run-1",
    baseCommit: "base",
    transitions: 0,
    maxTransitions: "",
    runTimeout: "",
    attempts: [
      {
        stepId: "work",
        attemptId: "001-work",
        number: 1,
        result: "",
        reason: "",
        outcome: "",
        message: "",
        startedAt: "first",
        index: 1,
        newest: false,
      },
      {
        stepId: "work",
        attemptId: "002-work",
        number: 2,
        result: "",
        reason: "",
        outcome: "",
        message: "",
        startedAt: "second",
        index: 2,
        newest: true,
      },
    ],
    attempt: {
      id: "003-work",
      number: 3,
      startedAt: "third",
      maxAttempts: 3,
      timeout: "30s",
      lastAttempt: true,
      iteration: 1,
      maxIterations: 1,
      lastIteration: true,
      previousIteration: "",
    },
    previous: "",
  });
});

test("run facts list earlier attempts and declared run limits", () => {
  const history = [
    created,
    started("001-work", "first"),
    {
      type: "outcome.reported",
      attemptId: "001-work",
      outcome: "again",
      message: "first message",
      seq: 2,
      at: "reported",
    },
    {
      type: "attempt.ended",
      attemptId: "001-work",
      result: "success",
      reason: "outcome",
      outcome: "again",
      seq: 3,
      at: "ended",
    },
    { type: "transition", seq: 4, at: "transitioned" },
    started("002-test", "second", "test"),
    {
      type: "attempt.ended",
      attemptId: "002-test",
      result: "failure",
      reason: "timeout",
      seq: 5,
      at: "timed out",
    },
    { type: "transition", seq: 6, at: "transitioned again" },
  ] as RunEvent[];
  const facts = runFacts(
    history,
    step,
    { attemptId: "003-work", stepId: "work", startedAt: "third" },
    "loop",
    [step, { ...step, id: "test" }],
    { maxTransitions: 4, declaredRunTimeout: "1h" },
  );
  assert.equal(facts.transitions, 2);
  assert.equal(facts.maxTransitions, 4);
  assert.equal(facts.runTimeout, "1h");
  assert.deepEqual(facts.attempts, [
    {
      stepId: "work",
      attemptId: "001-work",
      number: 1,
      result: "success",
      reason: "outcome",
      outcome: "again",
      message: "first message",
      startedAt: "first",
      index: 1,
      newest: false,
    },
    {
      stepId: "test",
      attemptId: "002-test",
      number: 1,
      result: "failure",
      reason: "timeout",
      outcome: "",
      message: "",
      startedAt: "second",
      index: 2,
      newest: true,
    },
  ]);
});

test("run facts use the current attempt start from the event log", () => {
  const facts = runFacts([started("001-work", "started")], step, {
    attemptId: "001-work",
    stepId: "work",
    startedAt: "fallback",
  });
  assert.equal(facts.attempt.number, 1);
  assert.equal(facts.attempt.startedAt, "started");
});

test("run facts use the current attempt timestamp when it is not in the event log", () => {
  const facts = runFacts(
    [],
    { ...step, maxAttempts: 5, declaredLimits: undefined },
    {
      attemptId: "001-work",
      stepId: "work",
      startedAt: "attempt",
    },
  );
  assert.deepEqual(facts.attempt, {
    id: "001-work",
    number: 1,
    startedAt: "attempt",
    maxAttempts: "",
    timeout: "",
    lastAttempt: false,
    iteration: 1,
    maxIterations: 1,
    lastIteration: true,
    previousIteration: "",
  });
  assert.equal(facts.previous, "");
});

test("Ralph iteration facts give the preceding iteration's reason", () => {
  const history = [
    {
      type: "iteration.ended",
      attemptId: "001-loop",
      iteration: 1,
      reason: "no_outcome",
      seq: 1,
      at: "first",
    },
    {
      type: "iteration.ended",
      attemptId: "001-loop",
      iteration: 2,
      reason: "nonzero_exit",
      seq: 2,
      at: "second",
    },
  ] as RunEvent[];
  const facts = [2, 3].map(
    (iteration) =>
      runFacts(history, ralph, {
        attemptId: "001-loop",
        stepId: "loop",
        startedAt: "started",
        iteration,
      }).attempt,
  );
  assert.deepEqual(facts, [
    {
      id: "001-loop",
      number: 1,
      startedAt: "started",
      maxAttempts: "",
      timeout: "",
      lastAttempt: false,
      iteration: 2,
      maxIterations: 3,
      lastIteration: false,
      previousIteration: { number: 1, reason: "no_outcome" },
    },
    {
      id: "001-loop",
      number: 1,
      startedAt: "started",
      maxAttempts: "",
      timeout: "",
      lastAttempt: false,
      iteration: 3,
      maxIterations: 3,
      lastIteration: true,
      previousIteration: { number: 2, reason: "nonzero_exit" },
    },
  ]);
});

test("an outcome_not_allowed failure clears its outcome and message", () => {
  const review: CommandStep = { ...step, id: "review", outputs: { feedback: [] } };
  const facts = runFacts(
    [
      {
        type: "outcome.reported",
        attemptId: "001-review",
        iteration: 1,
        outcome: "confused",
        message: "bad route",
        seq: 1,
        at: "reported",
      } as RunEvent,
      {
        type: "transition",
        from: "review",
        attemptId: "001-review",
        result: "failure",
        reason: "outcome_not_allowed",
        outcome: "confused",
        to: "work",
        cause: "onFailure",
        seq: 2,
        at: "transitioned",
      } as RunEvent,
    ],
    step,
    { attemptId: "002-work", stepId: "work", startedAt: "started" },
    "",
    [review, step],
  );
  assert.deepEqual(facts.previous, {
    stepId: "review",
    attemptId: "001-review",
    outcome: "",
    message: "",
    reason: "outcome_not_allowed",
    data: { review: { feedback: "" } },
  });
});

test("run facts take the latest transition into this step and its declared outputs", () => {
  const review: CommandStep = { ...step, id: "review", outputs: { feedback: [] } };
  const facts = runFacts(
    [
      {
        type: "outcome.reported",
        attemptId: "001-review",
        iteration: 1,
        outcome: "again",
        message: "earlier message",
        seq: 1,
        at: "earlier",
      } as RunEvent,
      {
        type: "outcome.reported",
        attemptId: "001-review",
        iteration: 2,
        outcome: "changes_requested",
        message: "needs work",
        seq: 2,
        at: "reported",
      } as RunEvent,
      {
        type: "transition",
        from: "review",
        attemptId: "001-review",
        result: "success",
        reason: "outcome",
        outcome: "changes_requested",
        to: "work",
        cause: "on",
        seq: 3,
        at: "transitioned",
      } as RunEvent,
    ],
    step,
    { attemptId: "002-work", stepId: "work", startedAt: "started" },
    "",
    [review, step],
  );
  assert.deepEqual(facts.previous, {
    stepId: "review",
    attemptId: "001-review",
    outcome: "changes_requested",
    message: "needs work",
    reason: "",
    data: { review: { feedback: "" } },
  });
});
