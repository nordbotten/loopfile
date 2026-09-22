import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDirectory } from "./directory-loader.ts";

const EXAMPLE = new URL("../../examples/minimal", import.meta.url).pathname;

test("examples/minimal loads with the real loader", async () => {
  const result = await loadDirectory(EXAMPLE);
  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  const { workflow } = result;
  assert.equal(workflow.formatVersion, 1);
  assert.deepEqual(workflow.inputs, {});
  assert.equal(workflow.steps.length, 2);
  const [write, check] = workflow.steps;
  assert.equal(write?.id, "write");
  assert.equal(write?.kind, "agent");
  assert.equal(check?.id, "check");
  assert.equal(check?.kind, "command");
  if (write?.kind === "agent") {
    assert.equal(write.harness, "claude");
    assert.deepEqual(write.on, { done: "check" });
    assert.equal(write.onFailure, "$failure");
    assert.ok(write.promptFile);
  }
  if (check?.kind === "command") {
    assert.deepEqual(check.on, {});
    assert.equal(check.onFailure, "$failure");
    assert.match(check.run, /hello\.txt/);
  }
});
