import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAttemptFolderName,
  iterationHeader,
  iterationOnNonRalphMessage,
  parseLogsArgs,
  selectAttempt,
  selectIteration,
  sortAttempts,
  streamHeader,
  unknownAttemptMessage,
  unknownIterationMessage,
  unknownRunMessage,
} from "./logs.ts";

test("parseLogsArgs needs a run ID", () => {
  const result = parseLogsArgs(["logs"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /needs a run ID/);
});

test("parseLogsArgs refuses a run ID that looks like a flag", () => {
  const result = parseLogsArgs(["logs", "--stdout"]);
  assert.equal(result.ok, false);
});

test("parseLogsArgs reads a bare run ID", () => {
  const result = parseLogsArgs(["logs", "r-1"]);
  assert.deepEqual(result, {
    ok: true,
    runId: "r-1",
    attempt: undefined,
    stream: undefined,
    iteration: undefined,
  });
});

test("parseLogsArgs reads an attempt after the run ID", () => {
  const result = parseLogsArgs(["logs", "r-1", "007-fix"]);
  assert.equal(result.ok, true);
  assert.equal((result as { attempt?: string }).attempt, "007-fix");
});

test("parseLogsArgs reads a bare attempt number", () => {
  const result = parseLogsArgs(["logs", "r-1", "7"]);
  assert.equal((result as { attempt?: string }).attempt, "7");
});

test("parseLogsArgs does not treat a flag as the attempt", () => {
  const result = parseLogsArgs(["logs", "r-1", "--stdout"]);
  assert.equal(result.ok, true);
  assert.equal((result as { attempt?: string }).attempt, undefined);
  assert.equal((result as { stream?: string }).stream, "stdout");
});

test("parseLogsArgs reads --stderr", () => {
  const result = parseLogsArgs(["logs", "r-1", "--stderr"]);
  assert.equal((result as { stream?: string }).stream, "stderr");
});

test("parseLogsArgs reads --owner", () => {
  const result = parseLogsArgs(["logs", "r-1", "--owner"]);
  assert.equal((result as { owner?: boolean }).owner, true);
});

test("parseLogsArgs refuses --stdout and --stderr together", () => {
  const result = parseLogsArgs(["logs", "r-1", "--stdout", "--stderr"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /cannot both be given/);
});

test("parseLogsArgs reads --iteration", () => {
  const result = parseLogsArgs(["logs", "r-1", "007-fix", "--iteration", "3"]);
  assert.equal((result as { iteration?: number }).iteration, 3);
});

test("parseLogsArgs refuses --iteration with no number", () => {
  const result = parseLogsArgs(["logs", "r-1", "--iteration"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /--iteration needs a number/);
});

test("parseLogsArgs refuses --iteration with a non-number", () => {
  const result = parseLogsArgs(["logs", "r-1", "--iteration", "abc"]);
  assert.equal(result.ok, false);
});

test("parseLogsArgs refuses an unknown flag", () => {
  const result = parseLogsArgs(["logs", "r-1", "--nope"]);
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /unknown argument: --nope/);
});

test("parseLogsArgs reads both stream flag and iteration in any order", () => {
  const result = parseLogsArgs(["logs", "r-1", "--iteration", "2", "--stdout"]);
  assert.equal(result.ok, true);
  assert.equal((result as { iteration?: number }).iteration, 2);
  assert.equal((result as { stream?: string }).stream, "stdout");
});

test("selectAttempt picks the newest when none is requested", () => {
  assert.equal(
    selectAttempt(["001-implement", "003-implement", "002-test"], undefined),
    "003-implement",
  );
});

test("selectAttempt returns nothing when there are no attempts", () => {
  assert.equal(selectAttempt([], undefined), undefined);
});

test("selectAttempt matches a full folder name", () => {
  assert.equal(selectAttempt(["001-implement", "002-test"], "002-test"), "002-test");
});

test("selectAttempt matches a bare number, padded or not", () => {
  assert.equal(selectAttempt(["001-implement", "002-test"], "2"), "002-test");
  assert.equal(selectAttempt(["001-implement", "002-test"], "002"), "002-test");
});

test("selectAttempt matches a widened number past 999", () => {
  assert.equal(selectAttempt(["0999-fix", "1000-fix"], "1000"), "1000-fix");
});

test("selectAttempt returns nothing when nothing matches", () => {
  assert.equal(selectAttempt(["001-implement"], "9"), undefined);
  assert.equal(selectAttempt(["001-implement"], "not-a-real-one"), undefined);
});

test("isAttemptFolderName accepts a real attempt folder and rejects a stray directory", () => {
  assert.equal(isAttemptFolderName("007-fix"), true);
  assert.equal(isAttemptFolderName("1000-fix"), true);
  assert.equal(isAttemptFolderName("stray"), false);
  assert.equal(isAttemptFolderName(".git"), false);
  assert.equal(isAttemptFolderName("fix-007"), false);
});

test("sortAttempts orders by attempt number", () => {
  assert.deepEqual(sortAttempts(["010-test", "002-test", "001-implement"]), [
    "001-implement",
    "002-test",
    "010-test",
  ]);
});

test("selectIteration matches a known iteration", () => {
  assert.equal(selectIteration([1, 2, 3], 2), 2);
});

test("selectIteration returns nothing for an unknown iteration", () => {
  assert.equal(selectIteration([1, 2, 3], 9), undefined);
});

test("streamHeader names the stream", () => {
  assert.equal(streamHeader("stderr"), "--- stderr ---\n");
  assert.equal(streamHeader("stdout"), "--- stdout ---\n");
});

test("iterationHeader zero-pads to two digits and widens past 99", () => {
  assert.equal(iterationHeader(3), "--- iteration 03 ---\n");
  assert.equal(iterationHeader(100), "--- iteration 100 ---\n");
});

test("unknownRunMessage names the run", () => {
  assert.match(unknownRunMessage("r-1"), /unknown run: r-1/);
});

test("unknownAttemptMessage lists valid attempts, sorted", () => {
  const message = unknownAttemptMessage("r-1", ["003-test", "001-implement"]);
  assert.match(message, /001-implement, 003-test/);
});

test("unknownAttemptMessage says when a run has none", () => {
  assert.match(unknownAttemptMessage("r-1", []), /has no attempts/);
});

test("iterationOnNonRalphMessage names the attempt", () => {
  assert.match(iterationOnNonRalphMessage("003-implement"), /003-implement/);
});

test("unknownIterationMessage lists valid iterations, padded and sorted", () => {
  assert.match(unknownIterationMessage("003-implement", [3, 1]), /01, 03/);
});

test("unknownIterationMessage says when an attempt has none", () => {
  assert.match(unknownIterationMessage("003-implement", []), /has no iterations/);
});
