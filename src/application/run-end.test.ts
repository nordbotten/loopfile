import assert from "node:assert/strict";
import { test } from "node:test";
import type { StatusProjection } from "../domain/status.ts";
import {
  endedExitCode,
  endedHelp,
  endedLine,
  runEndFromEvent,
  runEndFromStatus,
} from "./run-end.ts";

const RUN = "20260918-100000-abcd";
const NOW = "2026-09-18T10:01:05.000Z";

function status(overrides: Partial<StatusProjection> = {}): StatusProjection {
  return {
    formatVersion: 1,
    seq: 7,
    updatedAt: NOW,
    runId: RUN,
    loopfileName: "fix-bugs",
    loopId: null,
    loopIndex: null,
    state: "running",
    endReason: null,
    startedAt: "2026-09-18T10:00:00.000Z",
    endedAt: null,
    current: null,
    lastActivityAt: NOW,
    lastProgress: null,
    visitedSteps: [],
    lastTransition: null,
    transitions: 0,
    maxTransitions: 20,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      toolCalls: 0,
      permissionDenials: 0,
    },
    ...overrides,
  } as StatusProjection;
}

function statusEnd(overrides: Partial<StatusProjection> = {}) {
  return runEndFromStatus(status(overrides));
}

test("endedExitCode is 0 for a completed run and 1 for a failed or cancelled run", () => {
  assert.equal(endedExitCode(statusEnd({ state: "completed" })), 0);
  assert.equal(endedExitCode(statusEnd({ state: "failed" })), 1);
  assert.equal(endedExitCode(statusEnd({ state: "cancelled" })), 1);
});

test("endedLine is the run ID and the state", () => {
  assert.equal(endedLine(statusEnd({ state: "failed" })), `${RUN} failed\n`);
});

test("endedHelp is empty for a completed run", () => {
  assert.equal(endedHelp(statusEnd({ state: "completed", endReason: "success" })), "");
});

test("endedHelp names the reason, the last step and the commands to look further", () => {
  const ended = statusEnd({
    state: "failed",
    endReason: "attempt_limit",
    lastTransition: { from: "review", to: "$failure", cause: "onFailure", outcome: null },
  });
  assert.equal(
    endedHelp(ended),
    `run ${RUN} failed: attempt_limit at step "review"\n` +
      `  see: loopfile logs ${RUN}\n` +
      `       loopfile status ${RUN} --json\n`,
  );
});

test("endedHelp tells the operator how to allow denied tools on a failed run", () => {
  const ended = statusEnd({
    state: "failed",
    lastTransition: { from: "implement", to: "$failure", cause: "on", outcome: "blocked" },
    metrics: { ...status().metrics, permissionDenials: 38 },
  });
  assert.match(
    endedHelp(ended),
    /38 tool calls were denied\. Allow them in the step: args: \[--settings, '\{"permissions":\{"allow":\["Bash\(npm \*\)"\]\}\}'\]\./,
  );
});

test("endedHelp does not hint after a normal outcome", () => {
  const ended = statusEnd({
    state: "completed",
    metrics: { ...status().metrics, permissionDenials: 38 },
  });
  assert.equal(endedHelp(ended), "");
});

test("endedHelp leaves out the step when the run made no transition", () => {
  const ended = statusEnd({ state: "cancelled", endReason: "cancelled", lastTransition: null });
  assert.match(endedHelp(ended), new RegExp(`^run ${RUN} cancelled: cancelled\n  see:`));
});

test("runEndFromStatus takes the step from the last transition it left", () => {
  const end = statusEnd({
    state: "failed",
    lastTransition: { from: "build", to: "$failure", cause: "onFailure", outcome: null },
  });
  assert.equal(end.stepId, "build");
});

test("a run.ended success event is a completed run that exits 0", () => {
  const end = runEndFromEvent(RUN, {
    type: "run.ended",
    result: "success",
    reason: "end_state",
  });
  assert.deepEqual(end, {
    runId: RUN,
    state: "completed",
    endReason: "success",
    stepId: null,
  });
  assert.equal(endedExitCode(end), 0);
  assert.equal(endedHelp(end), "");
});

test("a run.ended failure event keeps its reason and step and exits 1", () => {
  const end = runEndFromEvent(RUN, {
    type: "run.ended",
    result: "failure",
    reason: "attempt_limit",
    stepId: "review",
  });
  assert.deepEqual(end, {
    runId: RUN,
    state: "failed",
    endReason: "attempt_limit",
    stepId: "review",
  });
  assert.equal(endedExitCode(end), 1);
  assert.match(endedHelp(end), /failed: attempt_limit at step "review"/);
});

test("a run.ended failure at an end state reads as failure, not end_state", () => {
  const end = runEndFromEvent(RUN, {
    type: "run.ended",
    result: "failure",
    reason: "end_state",
  });
  assert.equal(end.endReason, "failure");
});

test("a run.cancelled event is a cancelled run that exits 1", () => {
  const end = runEndFromEvent(RUN, { type: "run.cancelled" });
  assert.deepEqual(end, {
    runId: RUN,
    state: "cancelled",
    endReason: "cancelled",
    stepId: null,
  });
  assert.equal(endedExitCode(end), 1);
  assert.match(endedHelp(end), new RegExp(`^run ${RUN} cancelled: cancelled\n  see:`));
});
