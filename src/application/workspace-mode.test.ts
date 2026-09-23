import assert from "node:assert/strict";
import { test } from "node:test";
import { selectWorkspaceMode } from "./workspace-mode.ts";

test("workspace mode selection accepts empty without changing the isolate default", () => {
  assert.deepEqual(selectWorkspaceMode(undefined, undefined), { ok: true, mode: "isolate" });
  assert.deepEqual(selectWorkspaceMode(undefined, "isolate"), { ok: true, mode: "isolate" });
  assert.deepEqual(selectWorkspaceMode("isolate", undefined), { ok: true, mode: "isolate" });
  assert.deepEqual(selectWorkspaceMode("here", undefined), { ok: true, mode: "here" });
  assert.deepEqual(selectWorkspaceMode("here", "isolate"), { ok: true, mode: "here" });
  assert.deepEqual(selectWorkspaceMode("empty", undefined), { ok: true, mode: "empty" });
});
