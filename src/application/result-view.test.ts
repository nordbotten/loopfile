import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import { buildResultView, parseResultCommandArgs, renderResultView } from "./result-view.ts";

const created = {
  seq: 1,
  at: "2026-09-21T14:00:00.000Z",
  type: "run.created",
  runId: "run-1",
  eventFormatVersion: 1,
  modelDigest: "sha256:model",
  repositoryPath: "/repo",
  branch: "loopfile/run-1",
  baseCommit: "abc123",
  inputs: [],
} as const;

function view(...events: readonly Record<string, unknown>[]) {
  return buildResultView([created, ...events] as RunEvent[], "review-loop");
}

function failureMessage(argv: readonly string[]): string {
  const result = parseResultCommandArgs(argv);
  if (result.ok) throw new Error("expected argument failure");
  return result.message;
}

test("operator result arguments accept text and JSON forms", () => {
  assert.deepEqual(parseResultCommandArgs(["result", "run-1"]), {
    ok: true,
    runId: "run-1",
    json: false,
  });
  assert.deepEqual(parseResultCommandArgs(["result", "run-1", "--json"]), {
    ok: true,
    runId: "run-1",
    json: true,
  });
  assert.match(failureMessage(["result", "--json"]), /needs a run ID/);
  assert.match(failureMessage(["result", "--bad", "--json"]), /needs a run ID/);
  assert.match(failureMessage(["result", "run-1", "extra", "--json"]), /unknown argument: extra/);
});

test("a plain result has null loop fields and no loop line", () => {
  const result = view();
  assert.equal(result.state, "running");
  assert.equal(result.endReason, null);
  assert.equal(result.lastOutcome, null);
  assert.equal(result.loopId, null);
  assert.equal(result.loopIndex, null);
  assert.doesNotMatch(renderResultView(result), /^loop:/m);
});

test("a result in a loop carries and prints its link", () => {
  const result = buildResultView(
    [{ ...created, loopId: "loop-1", loopIndex: 2 } as RunEvent],
    "review-loop",
  );

  assert.equal(result.loopId, "loop-1");
  assert.equal(result.loopIndex, 2);
  assert.deepEqual(renderResultView(result).split("\n").slice(0, 3), [
    "run          run-1 · review-loop",
    "loop: loop-1 (run 2)",
    "state        running",
  ]);
});

test("a result carries the declared values", () => {
  const result = buildResultView([created], "review-loop", {
    inputs: {
      issue: { value: "42", size: 2, truncated: false, path: "/run/inputs/issue" },
    },
    outputs: {
      "review.feedback": {
        value: "looks good",
        size: 10,
        truncated: false,
        path: "/run/attempts/001-review/data/review.feedback",
      },
    },
  });
  assert.deepEqual(result.inputs.issue, {
    value: "42",
    size: 2,
    truncated: false,
    path: "/run/inputs/issue",
  });
  assert.deepEqual(result.outputs["review.feedback"], {
    value: "looks good",
    size: 10,
    truncated: false,
    path: "/run/attempts/001-review/data/review.feedback",
  });
});

test("the text result view keeps every field and value on one line", () => {
  const result = buildResultView(
    [
      created,
      {
        seq: 2,
        at: "2026-09-21T14:00:10.000Z",
        type: "attempt.started",
        attemptId: "001-review",
        stepId: "review",
        processGroupId: 1,
      },
      {
        seq: 3,
        at: "2026-09-21T14:00:20.000Z",
        type: "outcome.reported",
        attemptId: "001-review",
        outcome: "approved",
        message: "looks\ngood",
      },
    ],
    "review-loop",
    {
      inputs: { issue: { value: "42\nurgent", size: 10, truncated: false, path: "/inputs/issue" } },
      outputs: {
        "review.feedback": {
          value: "all\nclear",
          size: 9,
          truncated: false,
          path: "/outputs/feedback",
        },
      },
    },
  );

  const text = renderResultView(result);
  assert.match(text, /^run +run-1 · review-loop$/m);
  assert.match(text, /^last outcome +review \(001-review\) · approved: looks good$/m);
  assert.match(text, /^input +issue: 42 urgent$/m);
  assert.match(text, /^output +review\.feedback: all clear$/m);
  assert.doesNotMatch(text, /42\nurgent|all\nclear|looks\ngood/);
});

test("the newest outcome gets its step and a null message when none was given", () => {
  const result = view(
    {
      seq: 2,
      at: "2026-09-21T14:00:10.000Z",
      type: "attempt.started",
      attemptId: "001-review",
      stepId: "review",
      processGroupId: 1,
    },
    {
      seq: 3,
      at: "2026-09-21T14:00:20.000Z",
      type: "outcome.reported",
      attemptId: "001-review",
      outcome: "approved",
    },
    {
      seq: 4,
      at: "2026-09-21T14:00:30.000Z",
      type: "attempt.started",
      attemptId: "002-fix",
      stepId: "fix",
      processGroupId: 2,
    },
    {
      seq: 5,
      at: "2026-09-21T14:01:00.000Z",
      type: "run.ended",
      result: "success",
      reason: "end_state",
    },
  );
  assert.deepEqual(result.lastOutcome, {
    stepId: "review",
    attemptId: "001-review",
    outcome: "approved",
    message: null,
  });
  assert.equal(result.endedAt, "2026-09-21T14:01:00.000Z");
});

test("a terminal event carries its final metrics", () => {
  const result = view({
    seq: 2,
    at: "2026-09-21T14:01:00.000Z",
    type: "run.ended",
    result: "success",
    reason: "end_state",
    metrics: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: 3,
    },
  });
  assert.equal(result.metrics.permissionDenials, 3);
});

test("a cancelled run ends at its cancel event", () => {
  const result = view({
    seq: 2,
    at: "2026-09-21T14:01:00.000Z",
    type: "run.cancelled",
  });
  assert.equal(result.state, "cancelled");
  assert.equal(result.endReason, "cancelled");
  assert.equal(result.endedAt, "2026-09-21T14:01:00.000Z");
});

test("an outcome without its attempt keeps a stable empty step ID", () => {
  const result = view({
    seq: 2,
    at: "2026-09-21T14:00:20.000Z",
    type: "outcome.reported",
    attemptId: "missing",
    outcome: "approved",
  });
  assert.equal(result.lastOutcome?.stepId, "");
});

test("an invalid event list is rejected", () => {
  assert.throws(() => buildResultView([] as RunEvent[], "review-loop"), /run.created/);
});
