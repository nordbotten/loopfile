import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endInLine,
  missingActivityLogMessage,
  ownerGoneMessage,
  parseTailArgs,
  splitCompleteLines,
  TAIL_LINE_COUNT,
  throughEnd,
  unknownRunMessage,
} from "./tail.ts";

test("parseTailArgs needs a run ID", () => {
  const result = parseTailArgs(["tail"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /needs a run ID/);
});

test("parseTailArgs refuses a run ID that looks like a flag", () => {
  const result = parseTailArgs(["tail", "--foo"]);
  assert.equal(result.ok, false);
});

test("parseTailArgs reads a bare run ID", () => {
  const result = parseTailArgs(["tail", "r-1"]);
  assert.deepEqual(result, { ok: true, runId: "r-1", json: false });
});

test("parseTailArgs reads --json before or after the run ID", () => {
  assert.deepEqual(parseTailArgs(["tail", "r-1", "--json"]), {
    ok: true,
    runId: "r-1",
    json: true,
  });
  assert.deepEqual(parseTailArgs(["tail", "--json", "r-1"]), {
    ok: true,
    runId: "r-1",
    json: true,
  });
});

test("parseTailArgs needs a run ID with --json", () => {
  const result = parseTailArgs(["tail", "--json"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /needs a run ID/);
});

test("parseTailArgs refuses an extra argument", () => {
  const result = parseTailArgs(["tail", "r-1", "extra"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /unknown argument: extra/);
});

test("TAIL_LINE_COUNT is 10, like tail", () => {
  assert.equal(TAIL_LINE_COUNT, 10);
});

test("splitCompleteLines holds back a line with no newline yet", () => {
  const result = splitCompleteLines("a\nb\nc");
  assert.deepEqual(result.lines, ["a", "b"]);
  assert.equal(result.remainder, "c");
});

test("splitCompleteLines returns every line when the buffer ends in a newline", () => {
  const result = splitCompleteLines("a\nb\n");
  assert.deepEqual(result.lines, ["a", "b"]);
  assert.equal(result.remainder, "");
});

test("splitCompleteLines on an empty buffer holds nothing back", () => {
  const result = splitCompleteLines("");
  assert.deepEqual(result.lines, []);
  assert.equal(result.remainder, "");
});

const RUN = "20260917-160344-t1";
const ENDED = { type: "run.ended", seq: 3, at: "x", result: "failure", reason: "attempt_limit" };

test("endInLine reads a run.ended into the run's end, with its reason and step", () => {
  assert.deepEqual(endInLine(RUN, JSON.stringify({ ...ENDED, stepId: "review" })), {
    runId: RUN,
    state: "failed",
    endReason: "attempt_limit",
    stepId: "review",
  });
});

test("endInLine reads a run.ended success as a completed run", () => {
  const line = JSON.stringify({ type: "run.ended", result: "success", reason: "end_state" });
  assert.deepEqual(endInLine(RUN, line), {
    runId: RUN,
    state: "completed",
    endReason: "success",
    stepId: null,
  });
});

test("endInLine keeps internal_error as the failure reason", () => {
  const line = JSON.stringify({ type: "run.ended", result: "failure", reason: "internal_error" });
  assert.deepEqual(endInLine(RUN, line), {
    runId: RUN,
    state: "failed",
    endReason: "internal_error",
    stepId: null,
  });
});

test("endInLine carries denied tool calls from terminal metrics", () => {
  assert.deepEqual(
    endInLine(
      RUN,
      JSON.stringify({
        type: "run.ended",
        result: "failure",
        reason: "end_state",
        metrics: { permissionDenials: 38 },
      }),
    ),
    {
      runId: RUN,
      state: "failed",
      endReason: "failure",
      stepId: null,
      permissionDenials: 38,
    },
  );
});

test("endInLine reads a run.cancelled as a cancelled run", () => {
  const line = JSON.stringify({ type: "run.cancelled", seq: 3, at: "x" });
  assert.deepEqual(endInLine(RUN, line), {
    runId: RUN,
    state: "cancelled",
    endReason: "cancelled",
    stepId: null,
  });
});

test("endInLine ends a run.ended with no usable result or reason, as a failure", () => {
  const line = JSON.stringify({ type: "run.ended", seq: 3, at: "x" });
  assert.deepEqual(endInLine(RUN, line), {
    runId: RUN,
    state: "failed",
    endReason: "failure",
    stepId: null,
  });
  assert.equal(endInLine(RUN, JSON.stringify({ ...ENDED, reason: "bored" }))?.endReason, "failure");
  assert.equal(endInLine(RUN, JSON.stringify({ ...ENDED, stepId: 7 }))?.stepId, null);
});

test("endInLine is nothing for another event type", () => {
  assert.equal(endInLine(RUN, JSON.stringify({ type: "attempt.started" })), undefined);
});

test("endInLine is nothing for a blank line", () => {
  assert.equal(endInLine(RUN, ""), undefined);
  assert.equal(endInLine(RUN, "   "), undefined);
});

test("endInLine is nothing for a line that is not JSON", () => {
  assert.equal(endInLine(RUN, "not json"), undefined);
});

test("endInLine is nothing for a JSON line that is not an object", () => {
  assert.equal(endInLine(RUN, "[1,2,3]"), undefined);
  assert.equal(endInLine(RUN, "42"), undefined);
  assert.equal(endInLine(RUN, "null"), undefined);
});

test("endInLine is nothing when type is not a string", () => {
  assert.equal(endInLine(RUN, JSON.stringify({ type: 1 })), undefined);
});

test("throughEnd gives the lines up to and including the first end event, and that end", () => {
  const lines = [
    JSON.stringify({ type: "run.created" }),
    JSON.stringify(ENDED),
    JSON.stringify({ type: "attempt.started" }),
  ];
  const result = throughEnd(RUN, lines);
  assert.deepEqual(result.lines, lines.slice(0, 2));
  assert.equal(result.end?.state, "failed");
});

test("throughEnd gives every line and no end with no end event", () => {
  const lines = [JSON.stringify({ type: "run.created" }), "half"];
  assert.deepEqual(throughEnd(RUN, lines), { lines, end: undefined });
});

test("unknownRunMessage names the run", () => {
  assert.match(unknownRunMessage("r-1"), /unknown run: r-1/);
});

test("missingActivityLogMessage names the run", () => {
  assert.match(missingActivityLogMessage("r-1"), /r-1/);
});

test("ownerGoneMessage names the run", () => {
  assert.match(ownerGoneMessage("r-1"), /r-1/);
  assert.match(ownerGoneMessage("r-1"), /gone/);
});
