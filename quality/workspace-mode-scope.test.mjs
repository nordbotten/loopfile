import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
        ].includes(path) ||
        (!path.endsWith(".test.ts") &&
          /^src\/adapters\/(?:[^/]*harness[^/]*|monitor[^/]*)$/.test(path)),
    ),
    [],
  );
});

test("unrelated examples retain their Target repository wording", async () => {
  const [readme, prompt] = await Promise.all([
    readFile(new URL("../examples/implement-review/README.md", import.meta.url), "utf8"),
    readFile(new URL("../examples/implement-review/prompts/implement.md", import.meta.url), "utf8"),
  ]);
  assert.match(readme, /The target repository must\s+have an `npm test` script/);
  assert.match(prompt, /You work on the task in the target repository/);
});
