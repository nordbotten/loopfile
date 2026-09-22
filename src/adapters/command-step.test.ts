import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { CommandStep } from "../domain/model.ts";
import { attemptPaths, createAttemptDirectory } from "./attempt-directory.ts";
import { type CommandStepStart, startCommandStep } from "./command-step.ts";
import { localExecutor } from "./local-executor.ts";

const executor = localExecutor({ PATH: process.env.PATH }, 200);

function step(run: string): CommandStep {
  return {
    id: "tests",
    kind: "command",
    run,
    on: {},
    onFailure: "$failure",
    outputs: {},
    maxAttempts: 5,
    timeoutMs: 3_600_000,
  };
}

/** Every folder the tests make, removed once they all end. */
const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function start(run: string, workspace?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-cmd-")));
  folders.push(root);
  const attempt = await createAttemptDirectory(join(root, "attempts"), "001-tests");
  const context: ExecutionContext = {
    runId: "2026-09-18-0001",
    attemptId: "001-tests",
    stepId: "tests",
    workspace: workspace ?? root,
    scratch: attempt.scratch,
    endpoint: attempt.socket,
    attemptSecret: "s3cret",
  };
  const started = await startCommandStep(executor, step(run), context, attempt);
  return { started, attempt, root };
}

function running(started: CommandStepStart) {
  assert.equal(started.kind, "running", JSON.stringify(started));
  return started as Extract<CommandStepStart, { kind: "running" }>;
}

test("echo hi exits clean and hi is in the attempt's stdout file", async () => {
  const { started, attempt } = await start("echo hi");
  assert.deepEqual(await running(started).ended, {
    reason: "clean_exit",
    ended: { kind: "exited", code: 0 },
  });
  assert.equal(await readFile(attempt.stdout, "utf8"), "hi\n");
  assert.equal(await readFile(attempt.stderr, "utf8"), "");
});

test("a multi-line run stops at its first failing line with a non-zero exit", async () => {
  const { started, attempt } = await start("echo one\nfalse\necho two");
  assert.equal((await running(started).ended).reason, "nonzero_exit");
  assert.equal(await readFile(attempt.stdout, "utf8"), "one\n");
});

test("pipes and && work inside run, and stderr goes to its own file", async () => {
  const { started, attempt } = await start(
    "printf 'a\\nb\\n' | wc -l | tr -d ' ' && echo warn >&2",
  );
  assert.equal((await running(started).ended).reason, "clean_exit");
  assert.equal(await readFile(attempt.stdout, "utf8"), "2\n");
  assert.equal(await readFile(attempt.stderr, "utf8"), "warn\n");
});

test("the run line works in the workspace and sees its LOOPFILE_* context", async () => {
  const { started, attempt, root } = await start('pwd -P; echo "$LOOPFILE_ATTEMPT_ID"');
  await running(started).ended;
  assert.equal(await readFile(attempt.stdout, "utf8"), `${root}\n001-tests\n`);
});

test("cancel ends the step by signal, which is a failed attempt", async () => {
  const { started } = await start("sleep 60");
  const process = running(started);
  assert.ok(process.processGroupId > 0);
  process.cancel();
  assert.deepEqual(await process.ended, {
    reason: "nonzero_exit",
    ended: { kind: "signalled", signal: "SIGTERM" },
  });
});

test("a step that cannot start reports start_failed, apart from a non-zero exit", async () => {
  const { started, root } = await start("true", "/loopfile-no-such-workspace");
  assert.equal(started.kind, "start-failed");
  assert.equal(started.kind === "start-failed" && started.reason, "start_failed");
  const paths = attemptPaths(join(root, "attempts"), "001-tests");
  assert.equal(await readFile(paths.stdout, "utf8").catch(() => "none"), "none");
});
