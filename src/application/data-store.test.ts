import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import {
  checkPut,
  latestPut,
  parseDataKey,
  putsBy,
  RESERVED_DATA_STEP_ID,
  sha256,
  sourceOfGet,
} from "./data-store.ts";

let seq = 0;
function event(fields: Record<string, unknown>): RunEvent {
  seq += 1;
  return { seq, at: `2026-09-18T00:00:${String(seq).padStart(2, "0")}Z`, ...fields } as RunEvent;
}

function started(attemptId: string, stepId: string): RunEvent {
  return event({ type: "attempt.started", attemptId, stepId, processGroupId: 1 });
}

test("parseDataKey splits a well-shaped key into its step and name", () => {
  assert.deepEqual(parseDataKey("review.feedback"), { stepId: "review", name: "feedback" });
});

test("parseDataKey rejects a key with no dot, more than one dot, or a bad name", () => {
  assert.equal(parseDataKey("review"), undefined);
  assert.equal(parseDataKey("review.changes.feedback"), undefined);
  assert.equal(parseDataKey("Review.feedback"), undefined);
  assert.equal(parseDataKey("review.Feedback"), undefined);
  assert.equal(parseDataKey(".feedback"), undefined);
  assert.equal(parseDataKey("review."), undefined);
});

test("sha256 is deterministic and content-sensitive", () => {
  const a = sha256(Buffer.from("hello"));
  const b = sha256(Buffer.from("hello"));
  const c = sha256(Buffer.from("world"));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("checkPut allows a step to put under its own step ID", () => {
  const events = [started("001-review", "review")];
  assert.deepEqual(checkPut(events, "001-review", "review.feedback"), { ok: true });
});

test("checkPut refuses an unknown attempt", () => {
  const check = checkPut([], "001-review", "review.feedback");
  assert.equal(check.ok, false);
  assert.match((check as { reason: string }).reason, /no such attempt: 001-review/);
});

test("checkPut refuses a put after the attempt has ended", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "attempt.ended",
      attemptId: "001-review",
      result: "success",
      reason: "clean_exit",
    }),
  ];
  const check = checkPut(events, "001-review", "review.feedback");
  assert.equal(check.ok, false);
  assert.match((check as { reason: string }).reason, /attempt has ended.*001-review/);
});

test("checkPut refuses a put after the attempt was interrupted", () => {
  const events = [
    started("001-review", "review"),
    event({ type: "attempt.interrupted", attemptId: "001-review" }),
  ];
  assert.equal(checkPut(events, "001-review", "review.feedback").ok, false);
});

test("checkPut refuses a key that is not <step>.<name>", () => {
  const events = [started("001-review", "review")];
  const check = checkPut(events, "001-review", "review");
  assert.equal(check.ok, false);
  assert.match((check as { reason: string }).reason, /not a data key/);
});

test("checkPut refuses a put under the reserved input step, from any step", () => {
  const events = [started("001-review", "review"), started("002-input", RESERVED_DATA_STEP_ID)];
  assert.equal(checkPut(events, "001-review", "input.task").ok, false);
  // Even a step that is somehow named `input` cannot put under it.
  assert.equal(checkPut(events, "002-input", "input.task").ok, false);
});

test("checkPut refuses a put under another step's namespace", () => {
  const events = [started("001-review", "review")];
  const check = checkPut(events, "001-review", "implement.notes");
  assert.equal(check.ok, false);
  assert.match((check as { reason: string }).reason, /may put only under its own step \(review\)/);
});

function kindOf(check: ReturnType<typeof checkPut>): string | undefined {
  return check.ok ? undefined : check.kind;
}

test("checkPut's refusals each carry a kind a caller can act on without parsing text", () => {
  const events = [started("001-review", "review")];
  assert.equal(kindOf(checkPut([], "001-review", "review.feedback")), "stale_attempt");
  assert.equal(
    kindOf(
      checkPut(
        [
          started("001-review", "review"),
          event({
            type: "attempt.ended",
            attemptId: "001-review",
            result: "success",
            reason: "clean_exit",
          }),
        ],
        "001-review",
        "review.feedback",
      ),
    ),
    "stale_attempt",
  );
  assert.equal(kindOf(checkPut(events, "001-review", "review")), "invalid_key");
  assert.equal(kindOf(checkPut(events, "001-review", "input.task")), "invalid_key");
  assert.equal(kindOf(checkPut(events, "001-review", "implement.notes")), "invalid_key");
});

test("checkPut allows appending to a key that was never written", () => {
  const events = [started("001-review", "review")];
  assert.deepEqual(checkPut(events, "001-review", "review.feedback", true), { ok: true });
});

test("checkPut allows a second append on a key an earlier append started", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.feedback",
      size: 1,
      digest: "a",
      appended: true,
    }),
  ];
  assert.deepEqual(checkPut(events, "001-review", "review.feedback", true), { ok: true });
});

test("checkPut refuses a put on a key an append started, naming the command already used", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.feedback",
      size: 1,
      digest: "a",
      appended: true,
    }),
  ];
  const check = checkPut(events, "001-review", "review.feedback", false);
  assert.equal(check.ok, false);
  assert.equal((check as { kind: string }).kind, "write_kind_mismatch");
  assert.match((check as { reason: string }).reason, /first written with data append/);
});

test("checkPut refuses an append on a key a put started, naming the command already used", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.feedback",
      size: 1,
      digest: "a",
    }),
  ];
  const check = checkPut(events, "001-review", "review.feedback", true);
  assert.equal(check.ok, false);
  assert.equal((check as { kind: string }).kind, "write_kind_mismatch");
  assert.match((check as { reason: string }).reason, /first written with data put/);
});

test("latestPut returns the attempt of the last put for a key, not the first", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.feedback",
      size: 1,
      digest: "a",
    }),
    started("003-review", "review"),
    event({
      type: "data.put",
      attemptId: "003-review",
      key: "review.feedback",
      size: 2,
      digest: "b",
    }),
  ];
  assert.equal(latestPut(events, "review.feedback"), "003-review");
});

test("latestPut is undefined for a key that was never put", () => {
  assert.equal(latestPut([], "review.feedback"), undefined);
});

test("putsBy returns only the keys the given attempt put, not another attempt's", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.feedback",
      size: 1,
      digest: "a",
    }),
    event({ type: "data.put", attemptId: "001-review", key: "review.notes", size: 1, digest: "c" }),
    started("002-review", "review"),
    event({
      type: "data.put",
      attemptId: "002-review",
      key: "review.feedback",
      size: 2,
      digest: "b",
    }),
  ];
  assert.deepEqual(putsBy(events, "001-review"), new Set(["review.feedback", "review.notes"]));
  assert.deepEqual(putsBy(events, "002-review"), new Set(["review.feedback"]));
});

test("putsBy is empty for an attempt that put nothing", () => {
  assert.deepEqual(putsBy([started("001-review", "review")], "001-review"), new Set());
});

test("sourceOfGet reads an input key from the launch inputs, without looking at any put", () => {
  const events = [
    started("001-input", RESERVED_DATA_STEP_ID),
    event({ type: "data.put", attemptId: "001-input", key: "input.task", size: 1, digest: "a" }),
  ];
  assert.deepEqual(sourceOfGet(events, "input.task"), { kind: "input", name: "task" });
});

test("sourceOfGet reads a plain key from the attempt whose put was last", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.feedback",
      size: 1,
      digest: "a",
    }),
  ];
  assert.deepEqual(sourceOfGet(events, "review.feedback"), {
    kind: "attempt",
    attemptId: "001-review",
    writeIndex: undefined,
  });
});

test("sourceOfGet carries the write's own index for an appended key", () => {
  const events = [
    started("001-review", "review"),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.notes",
      size: 1,
      digest: "a",
      appended: true,
      writeIndex: 0,
    }),
    event({
      type: "data.put",
      attemptId: "001-review",
      key: "review.notes",
      size: 1,
      digest: "b",
      appended: true,
      writeIndex: 1,
    }),
  ];
  assert.deepEqual(sourceOfGet(events, "review.notes"), {
    kind: "attempt",
    attemptId: "001-review",
    writeIndex: 1,
  });
});

test("sourceOfGet is undefined for a plain key with no put and for a malformed key", () => {
  assert.equal(sourceOfGet([], "review.feedback"), undefined);
  assert.equal(sourceOfGet([], "review"), undefined);
});
