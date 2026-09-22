import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandStep } from "../domain/model.ts";
import { commandEndReason, commandStepRequest } from "./command-step.ts";
import type { ExecutionContext } from "./executor.ts";

const context: ExecutionContext = {
  runId: "2026-09-18-0001",
  attemptId: "002-tests",
  stepId: "tests",
  workspace: "/w",
  scratch: "/a/scratch",
  endpoint: "/a/sock",
  attemptSecret: "s3cret",
};

const step: CommandStep = {
  id: "tests",
  kind: "command",
  run: "npm test\nnpm run lint",
  on: {},
  onFailure: "$failure",
  outputs: {},
  maxAttempts: 5,
  timeoutMs: 3_600_000,
};

test("a command step runs its whole run line as one sh -e -c argument", () => {
  assert.deepEqual(commandStepRequest(step, context), {
    command: "sh",
    args: ["-e", "-c", "npm test\nnpm run lint"],
    context,
  });
});

test("only exit code 0 is a clean exit", () => {
  assert.equal(commandEndReason({ kind: "exited", code: 0 }), "clean_exit");
  assert.equal(commandEndReason({ kind: "exited", code: 1 }), "nonzero_exit");
  assert.equal(commandEndReason({ kind: "signalled", signal: "SIGTERM" }), "nonzero_exit");
});
