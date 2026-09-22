import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAdapter } from "./claude-harness.ts";
import { DEFAULT_HARNESS_ADAPTERS } from "./harness-adapters.ts";
import { piAdapter } from "./pi-harness.ts";

test("the default claude adapter is the Claude Code adapter", () => {
  assert.equal(DEFAULT_HARNESS_ADAPTERS.claude, claudeAdapter);
});

test("the default pi adapter is the PI adapter", () => {
  assert.equal(DEFAULT_HARNESS_ADAPTERS.pi, piAdapter);
});
