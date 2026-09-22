import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESSES, isHarnessName } from "./harnesses.ts";

test("isHarnessName is true for claude and pi only", () => {
  assert.equal(isHarnessName("claude"), true);
  assert.equal(isHarnessName("pi"), true);
  for (const name of ["fake", "codex", "", "constructor", "toString"]) {
    assert.equal(isHarnessName(name), false, name);
  }
});

test("the effort lists are exactly the manifest's", () => {
  assert.deepEqual(HARNESSES.claude.effort, ["low", "medium", "high", "max"]);
  assert.deepEqual(HARNESSES.pi.effort, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("claude owns the flags its adapter sets, and not --settings", () => {
  assert.deepEqual(HARNESSES.claude.ownedFlags, [
    "-p",
    "--print",
    "--output-format",
    "--input-format",
    "--verbose",
    "--model",
    "--effort",
  ]);
  assert.equal(HARNESSES.claude.ownedFlags.includes("--settings"), false);
});

test("pi owns its print, session, model and thinking flags", () => {
  assert.deepEqual(HARNESSES.pi.ownedFlags, [
    "-p",
    "--print",
    "--mode",
    "--no-session",
    "--session",
    "--session-id",
    "--session-dir",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--fork",
    "--model",
    "--thinking",
  ]);
});
