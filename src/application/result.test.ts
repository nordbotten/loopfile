import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import {
  checkResult,
  MESSAGE_LIMIT_BYTES,
  outcomeReportedFields,
  parseResultArgs,
  readResultReply,
} from "./result.ts";

test("the outcome is the second argument", () => {
  const args = parseResultArgs(["result", "approved"]);
  assert.deepEqual(args, { ok: true, outcome: "approved", truncated: false });
});

test("a missing outcome is a fixable missing_arg failure", () => {
  const failure = parseResultArgs(["result"]);
  assert.deepEqual(failure, {
    ok: false,
    summary: "`result` needs an outcome",
    code: "missing_arg",
    help: [
      "Usage: loopfile result <outcome> [--message <text>]",
      "The outcome must be one of the step's `on` keys",
    ],
  });
});

test("an empty outcome is treated the same as a missing one", () => {
  const failure = parseResultArgs(["result", ""]);
  assert.equal(failure.ok, false);
});

test("--message is carried along with the outcome", () => {
  const args = parseResultArgs(["result", "approved", "--message", "looks good"]);
  assert.equal(args.ok, true);
  assert.ok(args.ok && args.outcome === "approved");
  assert.ok(args.ok && args.message === "looks good");
  assert.ok(args.ok && !args.truncated);
});

test("no --message flag leaves the message unset", () => {
  const args = parseResultArgs(["result", "approved"]);
  assert.ok(args.ok && !("message" in args));
});

test("newlines and control characters in --message become spaces", () => {
  const args = parseResultArgs(["result", "approved", "--message", "line one\nline two\ttab"]);
  assert.ok(args.ok && args.message === "line one line two tab");
});

test("a --message within the byte limit is not truncated", () => {
  const message = "x".repeat(MESSAGE_LIMIT_BYTES);
  const args = parseResultArgs(["result", "approved", "--message", message]);
  assert.ok(args.ok && args.message === message);
  assert.ok(args.ok && !args.truncated);
});

test("a --message over the byte limit is cut and marked truncated", () => {
  const message = "x".repeat(MESSAGE_LIMIT_BYTES + 1);
  const args = parseResultArgs(["result", "approved", "--message", message]);
  assert.ok(args.ok && args.message === "x".repeat(MESSAGE_LIMIT_BYTES));
  assert.ok(args.ok && args.truncated);
});

test("truncation never splits a multi-byte UTF-8 character", () => {
  // 499 ASCII bytes (0-498) followed by the 2-byte "é" (499-500): the naive
  // cut at byte 500 would land inside "é"'s second byte, so the whole
  // character is dropped instead of leaving a stray byte.
  const message = `${"a".repeat(499)}é`;
  const args = parseResultArgs(["result", "approved", "--message", message]);
  assert.ok(args.ok && args.truncated);
  assert.ok(args.ok && args.message === "a".repeat(499));
});

test("a successful reply reports the outcome", () => {
  const report = readResultReply({ ok: true }, "approved");
  assert.deepEqual(report, { ok: true, summary: "reported approved" });
});

test("a bad_outcome refusal lists the allowed outcomes", () => {
  const report = readResultReply(
    {
      ok: false,
      code: "bad_outcome",
      message: '"nope" is not one of this step\'s outcomes',
      allowed: ["approved", "changes_requested"],
    },
    "nope",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "bad_outcome");
  assert.deepEqual(report.help, [
    '"nope" is not one of this step\'s outcomes',
    "Allowed outcomes: approved, changes_requested",
  ]);
});

test("a bad_outcome refusal with no allowed outcomes says the step has none", () => {
  const report = readResultReply(
    { ok: false, code: "bad_outcome", message: "no outcome is allowed", allowed: [] },
    "anything",
  );
  assert.ok(!report.ok);
  assert.match(report.help[1] ?? "", /no outcome is allowed/);
});

test("a reply with no recognisable shape reads as an unfixable refusal, not a crash", () => {
  for (const reply of [undefined, null, "not an object", 7, [], {}]) {
    const report = readResultReply(reply, "approved");
    assert.ok(!report.ok);
    assert.equal(report.code, "stale_attempt");
  }
});

function reported(attemptId: string, outcome: string, iteration?: number): RunEvent {
  return {
    type: "outcome.reported",
    seq: 1,
    at: "2026-09-18T00:00:00.000Z",
    attemptId,
    outcome,
    ...(iteration === undefined ? {} : { iteration }),
  };
}

test("a first call with an allowed outcome is accepted", () => {
  const check = checkResult([], "001-review", undefined, "approved", [
    "approved",
    "changes_requested",
  ]);
  assert.deepEqual(check, { ok: true });
});

test("an outcome outside the step's `on` keys is refused with the allowed list", () => {
  const check = checkResult([], "001-review", undefined, "nope", ["approved"]);
  assert.deepEqual(check, {
    ok: false,
    reason: '"nope" is not one of this step\'s outcomes',
    allowed: ["approved"],
  });
});

test("a step with no `on` map refuses every outcome", () => {
  const check = checkResult([], "001-review", undefined, "approved", []);
  assert.equal(check.ok, false);
});

test("a second call in the same attempt is refused, naming the first outcome", () => {
  const history = [reported("001-review", "approved")];
  const check = checkResult(history, "001-review", undefined, "changes_requested", [
    "approved",
    "changes_requested",
  ]);
  assert.deepEqual(check, {
    ok: false,
    reason: "outcome already reported: approved",
    allowed: ["approved", "changes_requested"],
  });
});

test("an earlier attempt's report never blocks this attempt", () => {
  const history = [reported("001-review", "approved")];
  const check = checkResult(history, "002-review", undefined, "approved", ["approved"]);
  assert.deepEqual(check, { ok: true });
});

test("a Ralph step resets the one-outcome rule each iteration", () => {
  const history = [reported("001-implement", "changes_requested", 1)];
  const check = checkResult(history, "001-implement", 2, "approved", [
    "approved",
    "changes_requested",
  ]);
  assert.deepEqual(check, { ok: true });
});

test("within one Ralph iteration a second call is still refused", () => {
  const history = [reported("001-implement", "approved", 2)];
  const check = checkResult(history, "001-implement", 2, "changes_requested", [
    "approved",
    "changes_requested",
  ]);
  assert.equal(check.ok, false);
});

test("outcomeReportedFields leaves out iteration and message when neither is given", () => {
  assert.deepEqual(outcomeReportedFields("001-review", undefined, "approved", undefined), {
    attemptId: "001-review",
    outcome: "approved",
  });
});

test("outcomeReportedFields carries iteration and message when both are given", () => {
  assert.deepEqual(outcomeReportedFields("001-implement", 2, "approved", "looks good"), {
    attemptId: "001-implement",
    iteration: 2,
    outcome: "approved",
    message: "looks good",
  });
});
