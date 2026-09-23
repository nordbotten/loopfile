import assert from "node:assert/strict";
import { test } from "node:test";
import { selectWorkspaceMode } from "./workspace-mode.ts";

test("workspace mode selection defaults to isolate and lets the flag override the manifest", () => {
  assert.deepEqual(selectWorkspaceMode(undefined, undefined), { ok: true, mode: "isolate" });
  assert.deepEqual(selectWorkspaceMode(undefined, "isolate"), { ok: true, mode: "isolate" });
  assert.deepEqual(selectWorkspaceMode("isolate", undefined), { ok: true, mode: "isolate" });
  assert.deepEqual(selectWorkspaceMode("here", "isolate"), {
    ok: false,
    message: "--workspace must be one of: isolate",
  });
  assert.deepEqual(selectWorkspaceMode("empty", undefined), {
    ok: false,
    message: "--workspace must be one of: isolate",
  });
});
