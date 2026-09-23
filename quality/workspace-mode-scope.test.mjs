import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

test("workspace modes leave the Monitor, Harness adapters, and ADR 0005 unchanged", () => {
  const workingTreeChanges = new Set([
    ...git("diff", "--name-only", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]);
  const changed =
    workingTreeChanges.size === 0
      ? git("show", "--pretty=format:", "--name-only", "HEAD")
      : [...workingTreeChanges];
  assert.deepEqual(
    changed.filter(
      (path) =>
        path === "docs/adr/0005-execution-context-contract.md" ||
        /^src\/adapters\/(?:[^/]*harness[^/]*|monitor[^/]*)$/.test(path),
    ),
    [],
  );
});
