import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopEvent } from "../domain/events.ts";
import { loopStatus } from "./loop-status.ts";
import {
  buildLoopStatusView,
  type LoopRunStatusView,
  loopTotals,
  renderLoopStatusView,
} from "./loop-status-view.ts";
import { UNKNOWN_METRICS } from "./status-projection.ts";

const START = "2026-09-22T12:00:00.000Z";
const END = "2026-09-22T12:01:00.000Z";
const NOW = "2026-09-22T12:02:00.000Z";
const CREATED: LoopEvent = {
  seq: 1,
  at: START,
  type: "loop.created",
  loopId: "loop-20260922-120000-aaaa",
  eventFormatVersion: 1,
  repositoryPath: "/repo",
  loopfileName: "review.loop",
  source: { kind: "times", count: 2 },
  fixedInputs: {},
  retry: 0,
  maxRuns: 2,
  pauseMs: null,
  program: { version: "0.1.0", digest: "sha256:program" },
};

function run(overrides: Partial<LoopRunStatusView> = {}): LoopRunStatusView {
  return {
    index: 1,
    runId: "20260922-120000-aaaa",
    inputSet: {},
    retryOf: null,
    state: "completed",
    elapsedMs: 10_000,
    metrics: { ...UNKNOWN_METRICS, costUsd: 1 },
    ...overrides,
  };
}

test("loop totals count states and average completed runs", () => {
  assert.deepEqual(
    loopTotals(
      [
        run({ elapsedMs: 10_000, metrics: { ...UNKNOWN_METRICS, costUsd: 1 } }),
        run({
          index: 2,
          runId: "20260922-120001-bbbb",
          elapsedMs: 20_000,
          retryOf: "20260922-120000-aaaa",
          metrics: { ...UNKNOWN_METRICS, costUsd: 2.62 },
        }),
        run({ index: 3, state: "failed", metrics: { ...UNKNOWN_METRICS, costUsd: 0.5 } }),
        run({ index: 4, state: "cancelled", metrics: UNKNOWN_METRICS }),
      ],
      START,
      END,
      NOW,
    ),
    {
      completed: 2,
      failed: 1,
      cancelled: 1,
      retries: 1,
      wallMs: 60_000,
      costUsd: 4.12,
      runsWithoutCost: 1,
      meanMsPerCompleted: 15_000,
      meanCostUsdPerCompleted: 1.81,
    },
  );
});

test("loop totals count runs without cost", () => {
  assert.deepEqual(
    loopTotals(
      [
        run({ metrics: { ...UNKNOWN_METRICS, costUsd: 1.5 } }),
        run({ index: 2, metrics: { ...UNKNOWN_METRICS, costUsd: 2.62 } }),
        run({ index: 3, state: "failed", metrics: UNKNOWN_METRICS }),
        run({ index: 4, state: "cancelled", metrics: null }),
      ],
      START,
      END,
      NOW,
    ),
    {
      completed: 2,
      failed: 1,
      cancelled: 1,
      retries: 0,
      wallMs: 60_000,
      costUsd: 4.12,
      runsWithoutCost: 2,
      meanMsPerCompleted: 10_000,
      meanCostUsdPerCompleted: 2.06,
    },
  );
});

test("loop totals use null for no costs and no completed means", () => {
  const runs = [
    run({ state: "failed", metrics: UNKNOWN_METRICS }),
    run({ index: 2, state: "cancelled", metrics: null }),
  ];
  assert.deepEqual(loopTotals(runs, START, null, NOW), {
    completed: 0,
    failed: 1,
    cancelled: 1,
    retries: 0,
    wallMs: 120_000,
    costUsd: null,
    runsWithoutCost: 2,
    meanMsPerCompleted: null,
    meanCostUsdPerCompleted: null,
  });

  const view = buildLoopStatusView(loopStatus([CREATED]), "completed", runs, NOW);
  assert.equal(
    renderLoopStatusView(view, null).trimEnd().split("\n").at(-1),
    "totals: 0 completed, 1 failed, 1 cancelled, 0 retries, wall 2:00, est. $- (2 runs without cost)",
  );
});

test("loop totals render cost and mean cost over completed runs", () => {
  const runs = [
    run({ metrics: { ...UNKNOWN_METRICS, costUsd: 1.5 } }),
    run({ index: 2, metrics: { ...UNKNOWN_METRICS, costUsd: 2.62 } }),
    run({ index: 3, state: "failed", metrics: UNKNOWN_METRICS }),
    run({ index: 4, state: "cancelled", metrics: null }),
  ];
  const view = buildLoopStatusView(loopStatus([CREATED]), "completed", runs, END);
  assert.equal(
    renderLoopStatusView(view, null).trimEnd().split("\n").at(-1),
    "totals: 2 completed, 1 failed, 1 cancelled, 0 retries, wall 1:00, est. $4.12 (2 runs without cost), mean 0:10 / est. $2.06 per completed run",
  );
});
