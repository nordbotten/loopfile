import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESSES, isHarnessEffort, isHarnessName } from "./harnesses.ts";

test("isHarnessName is true for claude and pi only", () => {
  assert.equal(isHarnessName("claude"), true);
  assert.equal(isHarnessName("pi"), true);
  for (const name of ["fake", "codex", "", "constructor", "toString"]) {
    assert.equal(isHarnessName(name), false, name);
  }
});

test("effort words are checked against the selected harness", () => {
  assert.equal(isHarnessEffort("claude", "high"), true);
  assert.equal(isHarnessEffort("claude", "xhigh"), false);
  assert.equal(isHarnessEffort("pi", "xhigh"), true);
  assert.equal(isHarnessEffort("pi", "huge"), false);
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
    "--setting-sources",
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
