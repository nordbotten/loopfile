import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DURATION_PATTERN,
  FORMAT_VERSION,
  NAME_PATTERN,
  RESERVED_STEP_IDS,
  type Workflow,
} from "./model.ts";

test("NAME_PATTERN accepts the documented names", () => {
  for (const name of ["a", "implement", "changes_requested", "step-1", "a".repeat(64)]) {
    assert.ok(NAME_PATTERN.test(name), name);
  }
});

test("NAME_PATTERN rejects everything else", () => {
  for (const name of ["", "1step", "-step", "Step", "step.name", "step name", "a".repeat(65)]) {
    assert.ok(!NAME_PATTERN.test(name), name);
  }
});

test("DURATION_PATTERN accepts the documented durations", () => {
  for (const duration of ["90s", "30m", "2h", "0.5h", "1.25s"]) {
    assert.ok(DURATION_PATTERN.test(duration), duration);
  }
});

test("DURATION_PATTERN rejects everything else", () => {
  for (const duration of ["", "30", "30d", "1h30m", "-5m", "m"]) {
    assert.ok(!DURATION_PATTERN.test(duration), duration);
  }
});

test("DURATION_PATTERN checks shape only, so zero passes and the loader rejects it", () => {
  assert.ok(DURATION_PATTERN.test("0s"));
  assert.ok(DURATION_PATTERN.test("0.0h"));
});

test("the step ID input is reserved", () => {
  assert.deepEqual([...RESERVED_STEP_IDS], ["input"]);
});

/**
 * The reference manifest (#76) as a model, so the types stay able to express the
 * whole of the v1 syntax. Typechecking this is the point; the run asserts only
 * that the loader's defaults have somewhere to land.
 */
const reference: Workflow = {
  formatVersion: FORMAT_VERSION,
  inputs: { task: "what to build, usually a whole issue body" },
  maxTransitions: 40,
  runTimeoutMs: 8 * 60 * 60 * 1000,
  steps: [
    {
      id: "implement",
      kind: "ralph",
      harness: "claude",
      model: "claude-opus-5",
      effort: "high",
      promptFile: "prompts/implement.md",
      args: [],
      timeoutMs: 30 * 60 * 1000,
      maxIterations: 20,
      maxAttempts: 6,
      on: { done: "test", blocked: "$failure" },
      onFailure: "$failure",
      outputs: {},
    },
    {
      id: "test",
      kind: "command",
      run: 'pnpm test > "$LOOPFILE_SCRATCH/test.log" 2>&1',
      timeoutMs: 15 * 60 * 1000,
      maxAttempts: 5,
      outputs: { log: [] },
      on: { passed: "review", failed: "implement" },
      onFailure: "test",
    },
    {
      id: "review",
      kind: "agent",
      harness: "pi",
      effort: "medium",
      promptFile: "prompts/review.md",
      args: [],
      timeoutMs: 60 * 60 * 1000,
      maxAttempts: 5,
      outputs: { feedback: ["changes_requested"] },
      on: { approved: "$success", changes_requested: "implement" },
      onFailure: "review",
    },
  ],
};

test("the reference workflow has an entry step and every default filled in", () => {
  assert.equal(reference.steps[0]?.id, "implement");
  for (const step of reference.steps) {
    assert.ok(step.maxAttempts >= 1, step.id);
    assert.ok(step.timeoutMs > 0, step.id);
    assert.ok(step.onFailure.length > 0, step.id);
  }
});
