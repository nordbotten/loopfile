import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

function changedFiles() {
  const workingTreeChanges = new Set([
    ...git("diff", "--name-only", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]);
  return workingTreeChanges.size === 0
    ? git("show", "--pretty=format:", "--name-only", "HEAD")
    : [...workingTreeChanges];
}

test("workspace mode docs leave ADRs 0005, 0006 and 0010, Monitor and Harness adapters unchanged", () => {
  assert.deepEqual(
    changedFiles().filter(
      (path) =>
        [
          "docs/adr/0005-execution-context-contract.md",
          "docs/adr/0006-format-versions.md",
          "docs/adr/0010-tail-json-events-are-public.md",
        ].includes(path) || /^src\/adapters\/(?:[^/]*harness[^/]*|monitor[^/]*)$/.test(path),
    ),
    [],
  );
});

test("workspace documentation edits do not sweep unrelated Target repository wording", () => {
  const allowed = new Set([
    "CONTEXT.md",
    "docs/adr/0001-node-typescript-stack.md",
    "docs/adr/0002-normalized-runtime-model.md",
    "docs/adr/0003-event-log-run-state.md",
    "docs/adr/0004-internal-harness-adapters-no-plugins.md",
    "docs/adr/0011-operator-contract.md",
    "docs/adr/0014-workspace-modes.md",
    "quality/workspace-mode-scope.test.mjs",
    "quality/workspace-modes-adr.test.mjs",
  ]);
  assert.deepEqual(
    changedFiles().filter((path) => !allowed.has(path)),
    [],
  );
});
