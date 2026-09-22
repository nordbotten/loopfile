import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import type { RunListEntry } from "../domain/run-list.ts";
import type { StatusProjection } from "../domain/status.ts";
import type { RecentTransition } from "../domain/status-view.ts";
import { UNKNOWN_METRICS } from "./status-projection.ts";
import {
  buildStatusView,
  parsePick,
  parseStatusArgs,
  recentTransitions,
  renderPicker,
  renderStatusView,
} from "./status-view.ts";

function status(overrides: Partial<StatusProjection> = {}): StatusProjection {
  return {
    formatVersion: 1,
    seq: 1,
    updatedAt: "2026-09-17T16:04:00.000Z",
    runId: "20260917-160300-aaaa",
    loopfileName: "review-loop",
    loopId: null,
    loopIndex: null,
    state: "running",
    endReason: null,
    startedAt: "2026-09-17T16:03:00.000Z",
    endedAt: null,
    current: null,
    lastActivityAt: "2026-09-17T16:04:00.000Z",
    lastProgress: null,
    visitedSteps: [],
    lastTransition: null,
    transitions: 0,
    maxTransitions: null,
    metrics: UNKNOWN_METRICS,
    ...overrides,
  };
}

const transition: RecentTransition = {
  at: "2026-09-17T16:03:30.000Z",
  from: "plan",
  to: "build",
  cause: "on",
  outcome: "approved",
};

test("parseStatusArgs accepts bare, a run ID, --json with a run ID, and --monitor with or without one", () => {
  const plain = { ok: true, json: false, monitor: false };
  assert.deepEqual(parseStatusArgs(["status"]), { ...plain, runId: undefined });
  assert.deepEqual(parseStatusArgs(["status", "r1"]), { ...plain, runId: "r1" });
  assert.deepEqual(parseStatusArgs(["status", "--json", "r1"]), {
    ...plain,
    runId: "r1",
    json: true,
  });
  assert.deepEqual(parseStatusArgs(["status", "--monitor"]), {
    ...plain,
    runId: undefined,
    monitor: true,
  });
  assert.deepEqual(parseStatusArgs(["status", "r1", "--monitor"]), {
    ...plain,
    runId: "r1",
    monitor: true,
  });
});

test("parseStatusArgs rejects --monitor with --json", () => {
  const result = parseStatusArgs(["status", "r1", "--monitor", "--json"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /--monitor or --json, not both/);
});

test("parseStatusArgs rejects --json without a run ID", () => {
  const result = parseStatusArgs(["status", "--json"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /needs a run ID/);
});

test("parseStatusArgs rejects unknown flags and a second run ID", () => {
  for (const argv of [
    ["status", "--bogus"],
    ["status", "a", "b"],
  ]) {
    const result = parseStatusArgs(argv);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /unknown argument/);
  }
});

test("recentTransitions keeps only transitions, the last N, oldest first, null for no outcome", () => {
  const events = [
    { type: "run.created", seq: 1, at: "t" },
    { type: "transition", seq: 2, at: "a", from: "s1", to: "s2", cause: "next" },
    { type: "transition", seq: 3, at: "b", from: "s2", to: "s3", cause: "on", outcome: "ok" },
    { type: "transition", seq: 4, at: "c", from: "s3", to: "s4", cause: "onFailure" },
  ] as unknown as RunEvent[];
  const result = recentTransitions(events, 2);
  assert.deepEqual(result, [
    { at: "b", from: "s2", to: "s3", cause: "on", outcome: "ok" },
    { at: "c", from: "s3", to: "s4", cause: "onFailure", outcome: null },
  ]);
  assert.equal(recentTransitions(events).length, 3);
});

test("buildStatusView swaps in the derived state and adds the transitions", () => {
  const view = buildStatusView(status(), "crashed", [transition]);
  assert.equal(view.state, "crashed");
  assert.deepEqual(view.recentTransitions, [transition]);
  assert.equal(view.formatVersion, 1);
  assert.equal(view.metrics.costUsd, null);
});

test("an active run shows state, identity, step, visited steps, transitions and unknown metrics", () => {
  const view = buildStatusView(
    status({
      current: {
        stepId: "build",
        stepKind: "ralph",
        attemptId: "a1",
        attempt: 2,
        maxAttempts: 3,
        iteration: 4,
        maxIterations: null,
        harness: "claude",
        startedAt: "2026-09-17T16:03:40.000Z",
      },
      visitedSteps: [
        { stepId: "plan", attempts: 1 },
        { stepId: "build", attempts: 2 },
      ],
      transitions: 1,
    }),
    "crashed",
    [transition, { ...transition, to: "end", outcome: null, cause: "next" }],
  );
  const text = renderStatusView(view);
  assert.match(text, /^run +20260917-160300-aaaa · review-loop$/m);
  assert.match(text, /^state +crashed$/m);
  assert.match(text, /^step +build \(ralph\) · attempt 2\/3 · iteration 4\/unknown · claude$/m);
  assert.match(text, /^visited +plan ×1, build ×2$/m);
  assert.match(
    text,
    /^recent +2026-09-17T16:03:30.000Z {2}plan -> build \(on, outcome approved\)$/m,
  );
  assert.match(text, /^ +2026-09-17T16:03:30.000Z {2}plan -> end \(next\)$/m);
  assert.match(
    text,
    /^metrics +input tokens unknown · output tokens unknown · total tokens unknown · cost unknown · tool calls unknown · permission denials unknown$/m,
  );
  assert.doesNotMatch(text, /^outcome/m);
});

test("a run in a loop prints its link after the run line", () => {
  const text = renderStatusView(
    buildStatusView(status({ loopId: "loop-1", loopIndex: 2 }), "running", []),
  );

  assert.deepEqual(text.split("\n").slice(0, 3), [
    "run         20260917-160300-aaaa · review-loop",
    "loop: loop-1 (run 2)",
    "state       running",
  ]);
});

test("a plain run has no loop line", () => {
  assert.doesNotMatch(renderStatusView(buildStatusView(status(), "running", [])), /^loop:/m);
});

test("an ended run shows its outcome and elapsed time, and a reported 0 is not unknown", () => {
  const view = buildStatusView(
    status({
      state: "completed",
      endReason: "success",
      endedAt: "2026-09-17T16:04:05.000Z",
      metrics: { ...UNKNOWN_METRICS, toolCalls: 0, costUsd: 1.5, permissionDenials: 2 },
    }),
    "completed",
    [],
  );
  const text = renderStatusView(view);
  assert.match(text, /^outcome +success at 2026-09-17T16:04:05.000Z$/m);
  assert.match(text, /^elapsed +1:05$/m);
  assert.match(text, /^visited +none$/m);
  assert.match(text, /^recent +none$/m);
  assert.match(text, /cost \$1.5 · tool calls 0 · permission denials 2$/m);
  assert.doesNotMatch(text, /^step/m);
});

test("a step with no iteration and no harness shows only kind and attempt", () => {
  const view = buildStatusView(
    status({
      current: {
        stepId: "lint",
        stepKind: "command",
        attemptId: "a1",
        attempt: 1,
        maxAttempts: 1,
        iteration: null,
        maxIterations: null,
        harness: null,
        startedAt: "2026-09-17T16:03:40.000Z",
      },
    }),
    "running",
    [],
  );
  assert.match(renderStatusView(view), /^step +lint \(command\) · attempt 1\/1$/m);
});

test("an ended run with no end reason says unknown", () => {
  const view = buildStatusView(
    status({ state: "failed", endedAt: "2026-09-17T16:04:00.000Z" }),
    "failed",
    [],
  );
  assert.match(renderStatusView(view), /^outcome +unknown at /m);
});

test("renderPicker numbers each run and leaves the header unnumbered", () => {
  const entry = (runId: string, state: RunListEntry["state"]): RunListEntry => ({
    runId,
    loopId: null,
    loopfileName: "x",
    state,
    currentStep: null,
    startedAt: "2026-09-17T16:03:00.000Z",
    elapsedMs: 1000,
  });
  const lines = renderPicker([entry("r1", "completed"), entry("r2", "completed")], false).split(
    "\n",
  );
  assert.match(lines[0] ?? "", /^ {4}RUN ID/);
  assert.match(lines[1] ?? "", /^1\) {2}r1/);
  assert.match(lines[2] ?? "", /^2\) {2}r2/);
  assert.equal(lines[3], "");
});

test("parsePick reads a number in range, q, and rejects the rest", () => {
  assert.equal(parsePick("1", 3), 0);
  assert.equal(parsePick(" 3 ", 3), 2);
  assert.equal(parsePick("q", 3), "quit");
  assert.equal(parsePick("Q", 3), "quit");
  assert.equal(parsePick("0", 3), undefined);
  assert.equal(parsePick("4", 3), undefined);
  assert.equal(parsePick("1x", 3), undefined);
  assert.equal(parsePick("", 3), undefined);
});
