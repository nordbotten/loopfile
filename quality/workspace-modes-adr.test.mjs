import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ADR = new URL("../docs/adr/0014-workspace-modes.md", import.meta.url);
const text = await readFile(ADR, "utf8");
const context = await readFile(new URL("../CONTEXT.md", import.meta.url), "utf8");
const adr0001 = await readFile(
  new URL("../docs/adr/0001-node-typescript-stack.md", import.meta.url),
  "utf8",
);
const adr0002 = await readFile(
  new URL("../docs/adr/0002-normalized-runtime-model.md", import.meta.url),
  "utf8",
);
const adr0003 = await readFile(
  new URL("../docs/adr/0003-event-log-run-state.md", import.meta.url),
  "utf8",
);
const adr0004 = await readFile(
  new URL("../docs/adr/0004-internal-harness-adapters-no-plugins.md", import.meta.url),
  "utf8",
);
const adr0011 = await readFile(
  new URL("../docs/adr/0011-operator-contract.md", import.meta.url),
  "utf8",
);

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
  assert.match(text, /a successful run attempts to remove only an `isolate` worktree/);
  assert.match(text, /If Git refuses, it stays and the reason is reported/);
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

test("CONTEXT defines Workspace mode and Target folder", () => {
  assert.match(context, /^\*\*Workspace mode\*\*:/m);
  assert.match(context, /`here`, `isolate` or `empty`/);
  assert.match(context, /^\*\*Target folder\*\*:/m);
  assert.doesNotMatch(context, /^\*\*Target repository\*\*:/m);
});

test("CONTEXT workspace lifecycle terms match the shipped modes", () => {
  assert.match(
    context,
    /In `isolate`, it is a worktree when Git can make one, otherwise a full copy/,
  );
  assert.match(context, /exists only for an `isolate` worktree/);
  assert.match(context, /same workspace and, if it has one, the same Run branch/);
  assert.match(context, /successful run attempts to remove its isolate worktree/);
  assert.match(context, /In `here`, only the run folder is deleted/);
  assert.match(
    context,
    /an isolate worktree with uncommitted changes refuses removal unless `remove --force`/,
  );
});

test("the workspace-related ADR edits match shipped behavior", () => {
  assert.match(adr0003, /every run records `workspacePath` and `workspaceMode`/);
  assert.match(adr0003, /Only an `isolate` worktree records `branch`[^.]*`baseCommit`/);
  assert.match(adr0003, /A successful run attempts to remove its isolate worktree/);
  assert.match(adr0011, /`workspace: <mode> · <path>`/);
  assert.match(adr0011, /Target folder when it has one/);
  assert.match(adr0011, /successful run attempts to remove its isolate worktree/);
  assert.match(
    adr0011,
    /an isolate worktree with uncommitted changes refuses removal unless `remove --force`/,
  );
  assert.match(adr0001, /Git is optional for workspace modes: every mode works without it/);
  assert.match(adr0002, /outside the run's workspace/);
  assert.match(adr0004, /part of the workspace/);
});

test("Isolate kind stays an event field, not a glossary term", () => {
  assert.doesNotMatch(context, /^\*\*Isolate kind\*\*:/im);
  assert.match(adr0003, /An `isolate` run also records `isolateKind` as `worktree` or `copy`/);
});
