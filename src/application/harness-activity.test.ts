import assert from "node:assert/strict";
import { test } from "node:test";
import { applyHarnessActivity } from "./harness-activity.ts";
import { NO_HARNESS_DATA } from "./status-projection.ts";

const AT = "2026-01-01T00:00:05.000Z";
const METRICS = { inputTokens: 5, outputTokens: 0, totalTokens: null, costUsd: null, toolCalls: 2 };

test("a tool call logs its name and target and sets the activity time", () => {
  const result = applyHarnessActivity(
    NO_HARNESS_DATA,
    { kind: "tool", tool: "edit", target: "src/x.ts" },
    AT,
  );
  assert.equal(result.logText, "edit src/x.ts");
  assert.equal(result.data.lastActivityAt, AT);
  assert.deepEqual(result.data.metrics, NO_HARNESS_DATA.metrics);
  assert.equal(result.data.lastProgress, null);
});

test("a tool call with no target logs the name alone", () => {
  const result = applyHarnessActivity(
    NO_HARNESS_DATA,
    { kind: "tool", tool: "think", target: "" },
    AT,
  );
  assert.equal(result.logText, "think");
});

test("progress text is logged and kept filtered as last progress", () => {
  const result = applyHarnessActivity(
    NO_HARNESS_DATA,
    { kind: "progress", text: "line one\nuses s3cret here" },
    AT,
    { attemptSecret: "s3cret" },
  );
  assert.equal(result.logText, "line one\nuses s3cret here");
  assert.equal(result.data.lastProgress, "line one uses *** here");
  assert.equal(result.data.lastActivityAt, AT);
});

test("metrics go to the data, never to the log; 0 stays 0 and unknown stays null", () => {
  const result = applyHarnessActivity(NO_HARNESS_DATA, { kind: "metrics", metrics: METRICS }, AT);
  assert.equal(result.logText, null);
  assert.deepEqual(result.data.metrics, METRICS);
  assert.equal(result.data.metrics.outputTokens, 0);
  assert.equal(result.data.metrics.costUsd, null);
  assert.equal(result.data.lastActivityAt, AT);
});

test("a later metrics report replaces an earlier one and keeps progress", () => {
  const first = applyHarnessActivity(NO_HARNESS_DATA, { kind: "progress", text: "working" }, AT);
  const second = applyHarnessActivity(first.data, { kind: "metrics", metrics: METRICS }, AT);
  assert.equal(second.data.lastProgress, "working");
  assert.deepEqual(second.data.metrics, METRICS);
});
