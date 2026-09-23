import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ADR = new URL("../docs/adr/0014-workspace-modes.md", import.meta.url);
const text = await readFile(ADR, "utf8");

test("ADR 0014 exists and follows the neighboring ADR structure", () => {
  assert.match(text, /^# Workspace modes\n\n[\s\S]+?\n## Decisions\n/m);
  assert.match(text, /^## Considered Options$/m);
  assert.match(text, /^## Consequences$/m);
});

test("the ADR defines each mode, the isolate fallback, defaults, records and cleanup", () => {
  assert.ok(text.includes("every step works in the launch folder itself"));
  assert.ok(text.includes("every step works in `runs/<runid>/workspace`"));
  assert.match(text, /When Git can make a worktree,[\s\S]*?Otherwise it makes a full copy/);
  assert.match(text, /no `\.git`, no commits, or no `git` binary/);
  assert.match(
    text,
    /every step works in a new empty folder[\s\S]*?Nothing is copied from the Target folder/,
  );
  assert.match(text, /The default is `isolate`/);
  assert.match(text, /`run\.created` records `workspacePath` and `workspaceMode` for every run/);
  assert.match(text, /`empty` omits it/);
  assert.match(text, /Only an `isolate` worktree records `branch` and `baseCommit`/);
  assert.match(text, /a successful run removes only an `isolate` worktree/);
  assert.match(text, /An `isolate` copy and an `empty` folder stay/);
  assert.match(text, /removed only when asked through `remove` or `prune`/);
});

test("the event and manifest format versions stay unchanged for their stated reasons", () => {
  assert.match(text, /event format `1` has not shipped/);
  assert.match(text, /no reader breaks/);
  assert.match(text, /ADR 0006 gets no pre-1\.0 carve-out/);
  assert.match(text, /optional top-level `workspace:` field/);
  assert.match(text, /manifest format version does not bump/);
});

test("the ADR records the ignored-files difference", () => {
  assert.match(text, /gitignored files such as `\.claude\/settings\.local\.json`/);
  assert.match(text, /a worktree does not bring them/);
});

test("the ADR records that here runs may share a folder", () => {
  assert.match(text, /Loopfile has no lock/);
  assert.match(text, /two `here` runs in one folder are allowed/);
  assert.match(text, /write to the same folder/);
});
