import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CorruptEventLogError,
  isCompleted,
  isInternalError,
  nextAttemptId,
  parseEventLog,
  type RunResult,
  replay,
} from "./replay.ts";

/** Minutes past 10:00 on one day, so a log reads as a timeline. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 8, 18, 10, minute)).toISOString();
}

/**
 * A hand-written `events.jsonl`: each event as it is written on the line, with
 * `seq` numbered in order so a test says only what it is about.
 */
function eventLog(...events: readonly Record<string, unknown>[]): string {
  return events.map((event, index) => `${JSON.stringify({ seq: index + 1, ...event })}\n`).join("");
}

const created = {
  type: "run.created",
  at: at(0),
  runId: "r-1",
  eventFormatVersion: 1,
  modelDigest: "sha256:model",
  repositoryPath: "/home/me/project",
  baseCommit: "9f1c0de",
  branch: "loopfile/r-1",
  inputs: [{ name: "issue", size: 2, digest: "sha256:42" }],
};

/** A clean run: plan reports an outcome, its route reaches fix, fix ends the run. */
const cleanRun = eventLog(
  created,
  { type: "owner.started", at: at(0), pid: 4242, host: "box" },
  { type: "attempt.started", at: at(1), attemptId: "001-plan", stepId: "plan", processGroupId: 91 },
  {
    type: "prompt.filled",
    at: at(1),
    attemptId: "001-plan",
    stepId: "plan",
    keys: { "input.issue": true },
    size: 120,
    digest: "sha256:prompt",
  },
  {
    type: "data.put",
    at: at(2),
    attemptId: "001-plan",
    key: "plan.notes",
    size: 120,
    digest: "sha256:notes",
  },
  { type: "outcome.reported", at: at(2), attemptId: "001-plan", outcome: "ready" },
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
    to: "fix",
    cause: "on",
  },
  { type: "attempt.started", at: at(3), attemptId: "002-fix", stepId: "fix", processGroupId: 92 },
  {
    type: "data.get",
    at: at(3),
    attemptId: "002-fix",
    key: "plan.notes",
    size: 120,
    digest: "sha256:notes",
  },
  {
    type: "attempt.ended",
    at: at(4),
    attemptId: "002-fix",
    result: "success",
    reason: "clean_exit",
  },
  {
    type: "transition",
    at: at(4),
    from: "fix",
    attemptId: "002-fix",
    result: "success",
    reason: "clean_exit",
    to: "$success",
    cause: "on",
  },
  { type: "run.ended", at: at(5), result: "success", reason: "end_state" },
);

test("replays a clean run", () => {
  const state = replay(parseEventLog(cleanRun));

  assert.deepEqual(state, {
    runId: "r-1",
    modelDigest: "sha256:model",
    currentStep: "fix",
    attempts: { plan: ["001-plan"], fix: ["002-fix"] },
    transitions: [
      {
        from: "plan",
        attemptId: "001-plan",
        result: "success",
        reason: "outcome",
        outcome: "ready",
        to: "fix",
        cause: "on",
      },
      {
        from: "fix",
        attemptId: "002-fix",
        result: "success",
        reason: "clean_exit",
        to: "$success",
        cause: "on",
      },
    ],
    attemptsSinceContinue: { plan: ["001-plan"], fix: ["002-fix"] },
    transitionsSinceContinue: [
      {
        from: "plan",
        attemptId: "001-plan",
        result: "success",
        reason: "outcome",
        outcome: "ready",
        to: "fix",
        cause: "on",
      },
      {
        from: "fix",
        attemptId: "002-fix",
        result: "success",
        reason: "clean_exit",
        to: "$success",
        cause: "on",
      },
    ],
    ownerTimeSinceContinueMs: 5 * 60_000,
    ownerTimeMs: 5 * 60_000,
    createdAt: at(0),
    lastEventAt: at(5),
    result: { result: "success", reason: "end_state" },
  });
});

test("run.continued starts fresh limit counts without erasing run history", () => {
  const events = parseEventLog(
    eventLog(
      created,
      { type: "owner.started", at: at(0), pid: 1, host: "box" },
      {
        type: "attempt.started",
        at: at(1),
        attemptId: "001-work",
        stepId: "work",
        processGroupId: 0,
      },
      {
        type: "attempt.ended",
        at: at(2),
        attemptId: "001-work",
        result: "failure",
        reason: "nonzero_exit",
      },
      {
        type: "transition",
        at: at(2),
        from: "work",
        attemptId: "001-work",
        result: "failure",
        reason: "nonzero_exit",
        to: "$failure",
        cause: "onFailure",
      },
      { type: "run.ended", at: at(3), result: "failure", reason: "end_state" },
      { type: "owner.started", at: at(10), pid: 2, host: "box" },
      { type: "run.continued", at: at(11) },
      {
        type: "attempt.started",
        at: at(12),
        attemptId: "002-work",
        stepId: "work",
        processGroupId: 0,
      },
    ),
  );
  const state = replay(events);
  assert.deepEqual(state.attempts, { work: ["001-work", "002-work"] });
  assert.deepEqual(state.attemptsSinceContinue, { work: ["002-work"] });
  assert.equal(state.transitions.length, 1);
  assert.equal(state.transitionsSinceContinue.length, 0);
  assert.equal(state.ownerTimeMs, 5 * 60_000);
  assert.equal(state.ownerTimeSinceContinueMs, 1 * 60_000);
  assert.equal(state.result, undefined);
});

test("isCompleted requires both a successful result and the end_state reason", () => {
  assert.equal(isCompleted({ result: "success", reason: "end_state" }), true);
  assert.equal(isCompleted({ result: "success", reason: "attempt_limit" }), false);
  assert.equal(isCompleted({ result: "failure", reason: "end_state" }), false);
  assert.equal(isCompleted({ result: "cancelled" }), false);
});

test("isInternalError requires the run not be cancelled, even if reason matches", () => {
  // Not a real event shape (a cancelled result carries no reason), but the
  // function is pure and takes whatever RunResult it is given.
  const cancelledWithReason = {
    result: "cancelled",
    reason: "internal_error",
  } as unknown as RunResult;
  assert.equal(isInternalError(cancelledWithReason), false);
  assert.equal(isInternalError({ result: "failure", reason: "internal_error" }), true);
  assert.equal(isInternalError({ result: "failure", reason: "end_state" }), false);
});

test("owner time since continue starts counting from the continuation instant, not zero", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        { type: "run.ended", at: at(1), result: "failure", reason: "internal_error" },
        { type: "run.continued", at: at(5) },
        { type: "owner.started", at: at(5), pid: 2, host: "box" },
        {
          type: "attempt.started",
          at: at(8),
          attemptId: "001-fix",
          stepId: "fix",
          processGroupId: 91,
        },
        {
          type: "attempt.ended",
          at: at(9),
          attemptId: "001-fix",
          result: "success",
          reason: "clean_exit",
        },
      ),
    ),
  );

  assert.equal(state.ownerTimeSinceContinueMs, 4 * 60_000);
});

test("a transition to an end state leaves the current step alone", () => {
  const state = replay(parseEventLog(cleanRun));

  assert.equal(state.currentStep, "fix");
});

test("a transition moves the current step before the next attempt starts", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        {
          type: "attempt.started",
          at: at(1),
          attemptId: "001-plan",
          stepId: "plan",
          processGroupId: 91,
        },
        {
          type: "attempt.ended",
          at: at(2),
          attemptId: "001-plan",
          result: "success",
          reason: "clean_exit",
        },
        {
          type: "transition",
          at: at(2),
          from: "plan",
          attemptId: "001-plan",
          result: "success",
          reason: "clean_exit",
          to: "fix",
          cause: "next",
        },
      ),
    ),
  );

  assert.equal(state.currentStep, "fix");
  assert.deepEqual(state.attempts, { plan: ["001-plan"] });
});

test("a run with no events after run.created has no step, no attempts and no result", () => {
  const state = replay(parseEventLog(eventLog(created)));

  assert.deepEqual(state, {
    runId: "r-1",
    modelDigest: "sha256:model",
    attempts: {},
    transitions: [],
    attemptsSinceContinue: {},
    transitionsSinceContinue: [],
    ownerTimeSinceContinueMs: 0,
    ownerTimeMs: 0,
    createdAt: at(0),
    lastEventAt: at(0),
  });
});

test("replays a cycle through onFailure as a second attempt of the same step", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        {
          type: "attempt.started",
          at: at(1),
          attemptId: "001-fix",
          stepId: "fix",
          processGroupId: 91,
        },
        {
          type: "attempt.ended",
          at: at(2),
          attemptId: "001-fix",
          result: "failure",
          reason: "missing_output",
          output: "patch",
        },
        {
          type: "transition",
          at: at(2),
          from: "fix",
          attemptId: "001-fix",
          result: "failure",
          reason: "missing_output",
          to: "fix",
          cause: "onFailure",
        },
        {
          type: "attempt.started",
          at: at(3),
          attemptId: "002-fix",
          stepId: "fix",
          processGroupId: 92,
        },
        {
          type: "attempt.ended",
          at: at(4),
          attemptId: "002-fix",
          result: "failure",
          reason: "outcome_not_allowed",
          outcome: "confused",
        },
        {
          type: "transition",
          at: at(4),
          from: "fix",
          attemptId: "002-fix",
          result: "failure",
          reason: "outcome_not_allowed",
          outcome: "confused",
          to: "$failure",
          cause: "onFailure",
        },
        { type: "run.ended", at: at(4), result: "failure", reason: "end_state" },
      ),
    ),
  );

  assert.deepEqual(state.attempts, { fix: ["001-fix", "002-fix"] });
  assert.deepEqual(state.transitions, [
    {
      from: "fix",
      attemptId: "001-fix",
      result: "failure",
      reason: "missing_output",
      to: "fix",
      cause: "onFailure",
    },
    {
      from: "fix",
      attemptId: "002-fix",
      result: "failure",
      reason: "outcome_not_allowed",
      outcome: "confused",
      to: "$failure",
      cause: "onFailure",
    },
  ]);
  assert.equal(state.currentStep, "fix");
  assert.deepEqual(state.result, { result: "failure", reason: "end_state" });
});

test("a Ralph step's iterations are not attempts", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        {
          type: "attempt.started",
          at: at(1),
          attemptId: "001-loop",
          stepId: "loop",
          processGroupId: 91,
        },
        {
          type: "iteration.started",
          at: at(1),
          attemptId: "001-loop",
          iteration: 1,
          processGroupId: 9,
        },
        {
          type: "iteration.ended",
          at: at(2),
          attemptId: "001-loop",
          iteration: 1,
          reason: "no_outcome",
        },
        {
          type: "iteration.started",
          at: at(2),
          attemptId: "001-loop",
          iteration: 2,
          processGroupId: 9,
        },
        {
          type: "iteration.ended",
          at: at(3),
          attemptId: "001-loop",
          iteration: 2,
          reason: "nonzero_exit",
        },
        {
          type: "iteration.started",
          at: at(3),
          attemptId: "001-loop",
          iteration: 3,
          processGroupId: 9,
        },
        { type: "outcome.reported", at: at(4), attemptId: "001-loop", outcome: "done" },
        {
          type: "iteration.ended",
          at: at(4),
          attemptId: "001-loop",
          iteration: 3,
          reason: "outcome",
        },
        {
          type: "attempt.ended",
          at: at(4),
          attemptId: "001-loop",
          result: "success",
          reason: "outcome",
          outcome: "done",
        },
      ),
    ),
  );

  assert.deepEqual(state.attempts, { loop: ["001-loop"] });
  assert.equal(state.currentStep, "loop");
  assert.equal(state.result, undefined);
});

test("a cancelled run ends as cancelled and keeps the interrupted attempt in the count", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        {
          type: "attempt.started",
          at: at(1),
          attemptId: "001-fix",
          stepId: "fix",
          processGroupId: 91,
        },
        { type: "attempt.interrupted", at: at(2), attemptId: "001-fix" },
        { type: "run.cancelled", at: at(2) },
      ),
    ),
  );

  assert.deepEqual(state.attempts, { fix: ["001-fix"] });
  assert.deepEqual(state.result, { result: "cancelled" });
});

test("a resumed internal error run has no result while its new owner is running", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        { type: "run.ended", at: at(1), result: "failure", reason: "internal_error" },
        { type: "owner.started", at: at(2), pid: 2, host: "box" },
        {
          type: "attempt.started",
          at: at(3),
          attemptId: "001-fix",
          stepId: "fix",
          processGroupId: 91,
        },
      ),
    ),
  );

  assert.equal(state.result, undefined);
});

test("an interrupted attempt counts, and run owner time skips the gap before the resume", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "owner.started", at: at(0), pid: 1, host: "box" },
        {
          type: "attempt.started",
          at: at(1),
          attemptId: "001-fix",
          stepId: "fix",
          processGroupId: 91,
        },
        // The run owner crashed here. The next event is written two hours later
        // by the run owner that resumed the run.
        { type: "owner.started", at: at(121), pid: 2, host: "box" },
        { type: "attempt.interrupted", at: at(121), attemptId: "001-fix" },
        {
          type: "attempt.started",
          at: at(121),
          attemptId: "002-fix",
          stepId: "fix",
          processGroupId: 92,
        },
        {
          type: "attempt.ended",
          at: at(124),
          attemptId: "002-fix",
          result: "success",
          reason: "clean_exit",
        },
        {
          type: "transition",
          at: at(124),
          from: "fix",
          attemptId: "002-fix",
          result: "success",
          reason: "clean_exit",
          to: "$success",
          cause: "next",
        },
        { type: "run.ended", at: at(124), result: "success", reason: "end_state" },
      ),
    ),
  );

  assert.deepEqual(state.attempts, { fix: ["001-fix", "002-fix"] });
  assert.equal(state.ownerTimeMs, 4 * 60_000);
});

test("run owner time is zero before the first owner.started", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "run.cancelled", at: at(9) },
        {
          type: "owner.started",
          at: at(10),
          pid: 1,
          host: "box",
        },
      ),
    ),
  );

  assert.equal(state.ownerTimeMs, 0);
});

test("a run.ended after a run.cancelled is the final result", () => {
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        { type: "run.cancelled", at: at(1) },
        { type: "run.ended", at: at(2), result: "failure", reason: "attempt_limit" },
      ),
    ),
  );

  assert.deepEqual(state.result, { result: "failure", reason: "attempt_limit" });
});

test("reads attempt metrics whether the field is present or absent", () => {
  const events = parseEventLog(
    eventLog(
      created,
      {
        type: "attempt.ended",
        at: at(1),
        attemptId: "001-plan",
        result: "success",
        reason: "clean_exit",
        metrics: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          costUsd: 4,
          toolCalls: 5,
          permissionDenials: null,
        },
      },
      {
        type: "attempt.ended",
        at: at(2),
        attemptId: "002-plan",
        result: "success",
        reason: "clean_exit",
      },
    ),
  );

  const withMetrics = events[1];
  assert.equal(withMetrics?.type, "attempt.ended");
  assert.deepEqual(withMetrics?.type === "attempt.ended" && withMetrics.metrics, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    costUsd: 4,
    toolCalls: 5,
    permissionDenials: null,
  });
  const withoutMetrics = events[2];
  assert.equal(withoutMetrics?.type, "attempt.ended");
  assert.equal(withoutMetrics?.type === "attempt.ended" && "metrics" in withoutMetrics, false);
});

test("reads a log whose last line has no newline", () => {
  const events = parseEventLog(cleanRun.trimEnd());

  assert.equal(events.length, 13);
  assert.equal(events.at(-1)?.seq, 13);
});

test("skips a last line that a crash cut in half", () => {
  const events = parseEventLog(`${cleanRun}{"seq":14,"type":"run.en`);

  assert.equal(events.length, 13);
  assert.equal(replay(events).result?.result, "success");
});

test("reports a broken line in the middle as corrupt, with its line number", () => {
  const lines = cleanRun.split("\n");
  lines[4] = '{"seq":5,"type":"data.p';

  assert.throws(
    () => parseEventLog(lines.join("\n")),
    (error: Error) => {
      assert.ok(error instanceof CorruptEventLogError);
      assert.match(error.message, /line 5/);
      return true;
    },
  );
});

test("a middle line that is JSON but not an event is corrupt too", () => {
  for (const line of [
    `{"seq":5,"at":"${at(2)}","type":"harness.tokens"}`,
    "[1,2,3]",
    "7",
    "null",
  ]) {
    const lines = cleanRun.split("\n");
    lines[4] = line;

    assert.throws(() => parseEventLog(lines.join("\n")), CorruptEventLogError, line);
  }
});

test("an event without a seq or a timestamp is not an event", () => {
  for (const line of ['{"at":"x","type":"run.cancelled"}', '{"seq":1,"type":"run.cancelled"}']) {
    const lines = cleanRun.split("\n");
    lines[4] = line;

    assert.throws(() => parseEventLog(lines.join("\n")), CorruptEventLogError, line);
  }
});

test("an empty log has no events, and replaying it fails", () => {
  assert.deepEqual(parseEventLog(""), []);
  assert.throws(() => replay([]), CorruptEventLogError);
});

test("a log that does not start with run.created is not a run's log", () => {
  const events = parseEventLog(
    eventLog({ type: "owner.started", at: at(0), pid: 1, host: "box" }, created),
  );

  assert.throws(() => replay(events), CorruptEventLogError);
});

test("the first attempt of a run is 001", () => {
  const state = replay(parseEventLog(eventLog(created)));

  assert.equal(nextAttemptId(state, "plan"), "001-plan");
});

test("the attempt number counts the whole run, not the step", () => {
  // The clean run visited two different steps, so the third attempt is 003
  // whichever step it is at.
  const state = replay(parseEventLog(cleanRun));

  assert.equal(nextAttemptId(state, "review"), "003-review");
  assert.equal(nextAttemptId(state, "plan"), "003-plan");
});

test("a step ID that names an Object member is counted like any other", () => {
  // `NAME_PATTERN` allows `constructor` and `toString`. Counted on a plain
  // object, the first attempt at one of these would start from the inherited
  // member and reach the folder name, the event and the socket path.
  const state = replay(
    parseEventLog(
      eventLog(
        created,
        {
          type: "attempt.started",
          at: at(1),
          attemptId: "001-constructor",
          stepId: "constructor",
          processGroupId: 91,
        },
        {
          type: "attempt.started",
          at: at(2),
          attemptId: "002-tostring",
          stepId: "toString",
          processGroupId: 92,
        },
      ),
    ),
  );

  assert.deepEqual(state.attempts, {
    constructor: ["001-constructor"],
    toString: ["002-tostring"],
  });
  assert.equal(nextAttemptId(state, "constructor"), "003-constructor");
});

test("the attempt number is padded to three digits and widens past 999", () => {
  const counted = (count: number) => ({
    ...replay(parseEventLog(eventLog(created))),
    attempts: { fix: Array.from({ length: count }, (_unused, index) => `${index}-fix`) },
  });

  assert.equal(nextAttemptId(counted(8), "fix"), "009-fix");
  assert.equal(nextAttemptId(counted(98), "fix"), "099-fix");
  assert.equal(nextAttemptId(counted(999), "fix"), "1000-fix");
});
