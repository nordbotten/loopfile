import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadDirectory, loadPacked } from "./directory-loader.ts";
import { packCommand } from "./pack-command.ts";

const EXAMPLE = new URL("../../examples/implement-review", import.meta.url).pathname;

const dir = await mkdtemp(join(tmpdir(), "loopfile-implement-review-"));
after(() => rm(dir, { recursive: true, force: true }));

async function loaded(load: Promise<Awaited<ReturnType<typeof loadDirectory>>>) {
  const result = await load;
  assert.equal(result.status, "loaded");
  return result.status === "loaded" ? result.workflow : undefined;
}

test("examples/implement-review loads with the real loader", async () => {
  const workflow = await loaded(loadDirectory(EXAMPLE));
  assert.deepEqual(workflow?.inputs, { task: "what to build, usually a whole issue body" });
  assert.equal(workflow?.maxTransitions, 40);
  assert.equal(workflow?.runTimeoutMs, 8 * 60 * 60 * 1000);
  const [implement, check, review] = workflow?.steps ?? [];
  assert.deepEqual(
    workflow?.steps.map((step) => [step.id, step.kind]),
    [
      ["implement", "ralph"],
      ["test", "command"],
      ["review", "agent"],
    ],
  );

  assert.equal(implement?.kind, "ralph");
  if (implement?.kind === "ralph") {
    assert.equal(implement.harness, "claude");
    assert.equal(implement.model, "claude-opus-5");
    assert.equal(implement.effort, "high");
    assert.equal(implement.maxIterations, 20);
    assert.equal(implement.maxAttempts, 6);
    assert.equal(implement.timeoutMs, 30 * 60 * 1000);
    assert.deepEqual(implement.on, { done: "test", blocked: "$failure" });
    assert.equal(implement.onFailure, "$failure");
  }

  assert.equal(check?.kind, "command");
  if (check?.kind === "command") {
    assert.deepEqual(check.outputs, { log: [] });
    assert.equal(check.onFailure, "test");
    assert.equal(check.timeoutMs, 15 * 60 * 1000);
    assert.deepEqual(check.on, { passed: "review", failed: "implement" });
    assert.match(check.run, /npm test/);
  }

  assert.equal(review?.kind, "agent");
  if (review?.kind === "agent") {
    assert.equal(review.harness, "claude");
    assert.equal(review.effort, "medium");
    assert.deepEqual(review.outputs, { feedback: ["changes_requested"] });
    assert.equal(review.maxAttempts, 5);
    assert.deepEqual(review.on, { approved: "$success", changes_requested: "implement" });
    assert.equal(review.onFailure, "review");
  }
});

test("the packed .loop of examples/implement-review loads to the same model", async () => {
  const file = join(dir, "implement-review.loop");
  let err = "";
  const code = await packCommand(
    ["pack", EXAMPLE, "-o", file],
    () => undefined,
    (text) => {
      err += text;
    },
  );
  assert.equal(code, 0, err);
  assert.deepEqual(await loaded(loadPacked(file)), await loaded(loadDirectory(EXAMPLE)));
});
