import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVITY_LINE_MAX_CHARS,
  activityLineForEvent,
  filterActivityText,
  formatActivityLine,
} from "./activity.ts";

test("filterActivityText collapses newlines and runs of whitespace to one space", () => {
  assert.equal(
    filterActivityText("first line\nsecond  line\t\tthird"),
    "first line second line third",
  );
});

test("filterActivityText trims leading and trailing whitespace", () => {
  assert.equal(filterActivityText("  padded  "), "padded");
});

test("filterActivityText leaves a short line untouched", () => {
  assert.equal(filterActivityText("edit src/x.ts"), "edit src/x.ts");
});

test("filterActivityText cuts a long line to about 200 characters and marks the cut", () => {
  const text = "x".repeat(300);
  const filtered = filterActivityText(text);
  assert.equal(filtered.length, ACTIVITY_LINE_MAX_CHARS);
  assert.ok(filtered.endsWith("…"));
  assert.equal(filtered.slice(0, -1), "x".repeat(ACTIVITY_LINE_MAX_CHARS - 1));
});

test("filterActivityText does not cut a line exactly at the limit", () => {
  const text = "x".repeat(ACTIVITY_LINE_MAX_CHARS);
  assert.equal(filterActivityText(text), text);
});

test("filterActivityText redacts the attempt secret", () => {
  const filtered = filterActivityText("token s3cr3t-value leaked", {
    attemptSecret: "s3cr3t-value",
  });
  assert.equal(filtered, "token *** leaked");
  assert.ok(!filtered.includes("s3cr3t-value"));
});

test("filterActivityText redacts every environment value given", () => {
  const filtered = filterActivityText("path /home/ada/work endpoint /tmp/run/sock", {
    environmentValues: ["/home/ada/work", "/tmp/run/sock"],
  });
  assert.equal(filtered, "path *** endpoint ***");
});

test("filterActivityText redacts both the attempt secret and environment values together", () => {
  const filtered = filterActivityText("secret=topsecret home=/home/ada", {
    attemptSecret: "topsecret",
    environmentValues: ["/home/ada"],
  });
  assert.equal(filtered, "secret=*** home=***");
});

test("filterActivityText ignores an empty secret rather than redacting every character", () => {
  const filtered = filterActivityText("plain text", { attemptSecret: "" });
  assert.equal(filtered, "plain text");
});

test("filterActivityText with no secrets given leaves the text alone", () => {
  assert.equal(filterActivityText("plain text"), "plain text");
});

test("activityLineForEvent reports a step start", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 1,
      at: "2026-09-18T09:14:02.000Z",
      type: "attempt.started",
      attemptId: "001-implement",
      stepId: "implement",
      processGroupId: 123,
    }),
    { attemptId: "001-implement", text: "step started" },
  );
});

test("activityLineForEvent reports a step end with its reason, underscores as spaces", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 2,
      at: "2026-09-18T09:15:44.000Z",
      type: "attempt.ended",
      attemptId: "001-implement",
      result: "failure",
      reason: "outcome_not_allowed",
    }),
    { attemptId: "001-implement", text: "step ended outcome not allowed" },
  );
});

test("activityLineForEvent reports the outcome of a result call", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 3,
      at: "2026-09-18T09:15:44.000Z",
      type: "outcome.reported",
      attemptId: "001-implement",
      outcome: "complete",
    }),
    { attemptId: "001-implement", text: "outcome complete" },
  );
});

test("activityLineForEvent reports the route a transition took", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 4,
      at: "2026-09-18T09:15:44.000Z",
      type: "transition",
      from: "implement",
      attemptId: "001-implement",
      result: "success",
      reason: "outcome",
      outcome: "complete",
      to: "tests",
      cause: "on",
    }),
    { attemptId: "001-implement", text: "route implement -> tests" },
  );
});

test("activityLineForEvent reports a data get with its key", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 5,
      at: "2026-09-18T09:14:08.000Z",
      type: "data.get",
      attemptId: "001-implement",
      key: "implement.md",
      size: 10,
      digest: "sha256:abc",
    }),
    { attemptId: "001-implement", text: "data get implement.md" },
  );
});

test("activityLineForEvent reports a plain data put as put", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 6,
      at: "2026-09-18T09:14:08.000Z",
      type: "data.put",
      attemptId: "001-implement",
      key: "review.md",
      size: 10,
      digest: "sha256:abc",
    }),
    { attemptId: "001-implement", text: "data put review.md" },
  );
});

test("activityLineForEvent reports an appended data put as append", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 7,
      at: "2026-09-18T09:14:08.000Z",
      type: "data.put",
      attemptId: "001-implement",
      key: "log.md",
      size: 10,
      digest: "sha256:abc",
      appended: true,
      writeIndex: 1,
    }),
    { attemptId: "001-implement", text: "data append log.md" },
  );
});

test("activityLineForEvent has nothing to say about an event ADR 0007 does not name", () => {
  assert.equal(
    activityLineForEvent({
      seq: 8,
      at: "2026-09-18T09:14:08.000Z",
      type: "owner.started",
      pid: 1,
      host: "ada",
    }),
    null,
  );
});

test("formatActivityLine writes local HH:MM:SS, the attempt ID, then the text", () => {
  const at = new Date(2026, 8, 18, 9, 14, 2);
  assert.equal(
    formatActivityLine(at, "001-implement", "step started"),
    "09:14:02 001-implement step started",
  );
});

test("formatActivityLine pads single-digit hours, minutes and seconds", () => {
  const at = new Date(2026, 8, 18, 1, 2, 3);
  assert.equal(
    formatActivityLine(at, "001-implement", "step started"),
    "01:02:03 001-implement step started",
  );
});

test("formatActivityLine leaves the attempt ID out when there is none", () => {
  const at = new Date(2026, 8, 18, 9, 14, 2);
  assert.equal(formatActivityLine(at, null, "run cancelled"), "09:14:02 run cancelled");
});

test("activityLineForEvent reports an interrupted step and a cancelled run", () => {
  assert.deepEqual(
    activityLineForEvent({
      seq: 9,
      at: "2026-09-18T09:14:09.000Z",
      type: "attempt.interrupted",
      attemptId: "001-implement",
    }),
    { attemptId: "001-implement", text: "step interrupted" },
  );
  assert.deepEqual(
    activityLineForEvent({ seq: 10, at: "2026-09-18T09:14:09.000Z", type: "run.cancelled" }),
    { attemptId: null, text: "run cancelled" },
  );
});
