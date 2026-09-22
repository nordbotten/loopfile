import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AttemptIdentity,
  CANCEL,
  checkAttemptCall,
  confirmsCancel,
  confirmsInterrupt,
  controlReply,
  decodeMessage,
  encodeMessage,
  INTERRUPT,
  PING,
  readyMessage,
  refusesInterrupt,
} from "./owner-protocol.ts";

const RUN = "20260917-160344-k3f9";
const ATTEMPT: AttemptIdentity = { attemptId: "007-fix", secret: "s3cret" };
const ITERATION: AttemptIdentity = { ...ATTEMPT, iteration: 2 };

function line(message: unknown): string {
  return encodeMessage(message).trimEnd();
}

test("a message is one line, and reads back as itself", () => {
  const text = encodeMessage({ type: PING });
  assert.ok(text.endsWith("\n"), "each message ends its own line");
  assert.equal(text.indexOf("\n"), text.length - 1, "a message never spans two lines");
  assert.deepEqual(decodeMessage(text), { type: "ping" });
});

test("anything that is not a JSON object decodes to nothing", () => {
  for (const text of ["", "{", "null", "7", '"ping"', "[1,2]"]) {
    assert.equal(decodeMessage(text), undefined, text);
  }
});

test("a ping is answered with the run ID", () => {
  assert.deepEqual(controlReply(line({ type: PING }), RUN), { type: "pong", runId: RUN });
});

test("ready carries the run ID too, so one greeting proves liveness", () => {
  assert.deepEqual(readyMessage(RUN), { type: "ready", runId: RUN });
});

test("a cancel is answered with cancelling and the run ID", () => {
  assert.equal(CANCEL, "cancel");
  assert.deepEqual(controlReply(line({ type: CANCEL }), RUN), { type: "cancelling", runId: RUN });
});

test("an interrupt is answered only while an attempt can be stopped", () => {
  assert.equal(INTERRUPT, "interrupt");
  assert.deepEqual(controlReply(line({ type: INTERRUPT }), RUN), {
    type: "interrupting",
    runId: RUN,
  });
  assert.deepEqual(controlReply(line({ type: INTERRUPT }), RUN, false), {
    type: "error",
    message: "no attempt is running",
  });
});

test("interrupt replies identify success and no attempt", () => {
  assert.equal(confirmsInterrupt(line({ type: "interrupting", runId: RUN }), RUN), true);
  assert.equal(confirmsInterrupt(line({ type: "interrupting", runId: "other" }), RUN), false);
  assert.equal(refusesInterrupt(line({ type: "error", message: "no attempt is running" })), true);
  assert.equal(refusesInterrupt(line({ type: "ready", runId: RUN })), false);
});

test("only this run's cancelling reply confirms a cancel", () => {
  assert.equal(confirmsCancel(line({ type: "cancelling", runId: RUN }), RUN), true);
  assert.equal(confirmsCancel(line({ type: "cancelling", runId: "other" }), RUN), false);
  assert.equal(confirmsCancel(line({ type: "ready", runId: RUN }), RUN), false);
  assert.equal(confirmsCancel("not json", RUN), false);
});

test("an unknown or unreadable request is named back, never ignored", () => {
  const unknown = controlReply(line({ type: "stop" }), RUN);
  assert.equal(unknown.type, "error");
  assert.match((unknown as { message: string }).message, /stop/);

  const broken = controlReply("not json", RUN);
  assert.equal(broken.type, "error");
  assert.match((broken as { message: string }).message, /JSON object/);
});

test("a call from the attempt running now is accepted with its arguments", () => {
  const check = checkAttemptCall(line({ ...ATTEMPT, argv: ["data", "get", "spec.md"] }), ATTEMPT);
  assert.equal(check.accepted, true);
  assert.ok(check.accepted);
  assert.deepEqual(check.call.argv, ["data", "get", "spec.md"]);
  assert.equal(check.call.attemptId, ATTEMPT.attemptId);
});

test("another attempt's ID or secret is refused as stale", () => {
  for (const call of [
    { ...ATTEMPT, attemptId: "006-review", argv: ["result", "approved"] },
    { ...ATTEMPT, secret: "guessed", argv: ["result", "approved"] },
    { attemptId: ATTEMPT.attemptId, argv: ["result", "approved"] },
  ]) {
    const check = checkAttemptCall(line(call), ATTEMPT);
    assert.equal(check.accepted, false);
    assert.ok(!check.accepted);
    assert.equal(check.refusal.code, "stale_attempt");
    assert.equal(check.refusal.ok, false);
  }
});

test("on a Ralph step the iteration must match too", () => {
  const stale = checkAttemptCall(line({ ...ITERATION, iteration: 1, argv: ["x"] }), ITERATION);
  assert.ok(!stale.accepted);
  assert.equal(stale.refusal.code, "stale_attempt");

  const current = checkAttemptCall(line({ ...ITERATION, argv: ["x"] }), ITERATION);
  assert.ok(current.accepted);
  assert.equal(current.call.iteration, 2);
});

test("an iteration on a step that has none is refused, and the other way round", () => {
  const extra = checkAttemptCall(line({ ...ATTEMPT, iteration: 1, argv: ["x"] }), ATTEMPT);
  assert.ok(!extra.accepted);
  assert.equal(extra.refusal.code, "stale_attempt");

  const missing = checkAttemptCall(line({ ...ATTEMPT, argv: ["x"] }), ITERATION);
  assert.ok(!missing.accepted);
  assert.equal(missing.refusal.code, "stale_attempt");
});

test("a request that is not a call is refused as a bad request, not as stale", () => {
  for (const text of ["not json", line({ ...ATTEMPT }), line({ ...ATTEMPT, argv: "data get" })]) {
    const check = checkAttemptCall(text, ATTEMPT);
    assert.ok(!check.accepted);
    assert.equal(check.refusal.code, "bad_request");
  }
});

test("a secret is never matched loosely", () => {
  const check = checkAttemptCall(line({ ...ATTEMPT, secret: ["s3cret"], argv: ["x"] }), ATTEMPT);
  assert.ok(!check.accepted);
  assert.equal(check.refusal.code, "stale_attempt");
});

test("a call is refused as stale when no identity is current", () => {
  const check = checkAttemptCall(line({ ...ATTEMPT, argv: ["result", "ok"] }), undefined);
  assert.deepEqual(check, {
    accepted: false,
    refusal: { ok: false, code: "stale_attempt", message: "no iteration is running" },
  });
});
