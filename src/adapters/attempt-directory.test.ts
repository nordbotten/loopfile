import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { nextAttemptId, parseEventLog, replay } from "../application/replay.ts";
import type { StepId } from "../domain/model.ts";
import {
  ATTEMPT_SOCKET_NAME,
  type AttemptPaths,
  attemptPaths,
  createAttemptDirectory,
  createIterationDirectory,
  iterationPaths,
} from "./attempt-directory.ts";
import { RunDirectoryError } from "./run-directory.ts";

test("every attempt file sits under the attempt folder", () => {
  const paths = attemptPaths("/tmp/lf/runs/r-1/attempts", "007-fix");
  assert.deepEqual(paths, {
    root: "/tmp/lf/runs/r-1/attempts/007-fix",
    stdout: "/tmp/lf/runs/r-1/attempts/007-fix/stdout",
    stderr: "/tmp/lf/runs/r-1/attempts/007-fix/stderr",
    socket: "/tmp/lf/runs/r-1/attempts/007-fix/sock",
    scratch: "/tmp/lf/runs/r-1/attempts/007-fix/scratch",
    wiring: "/tmp/lf/runs/r-1/attempts/007-fix/wiring",
    data: "/tmp/lf/runs/r-1/attempts/007-fix/data",
    iterations: "/tmp/lf/runs/r-1/attempts/007-fix/iterations",
  });
});

test("the socket keeps the short name the launch budget reserves", () => {
  // `createRunDirectory` budgets for `<nnnn>-<step>/sock`. A longer name here
  // would let a launch pass a check that its attempts then fail to bind against.
  assert.equal(ATTEMPT_SOCKET_NAME, "sock");
  assert.equal(basename(attemptPaths("/a", "001-fix").socket), ATTEMPT_SOCKET_NAME);
});

test("a Ralph iteration's output sits under the attempt, and the number widens", () => {
  const attempt = attemptPaths("/a", "001-fix");
  assert.deepEqual(iterationPaths(attempt, 7), {
    root: "/a/001-fix/iterations/07",
    stdout: "/a/001-fix/iterations/07/stdout",
    stderr: "/a/001-fix/iterations/07/stderr",
    wiring: "/a/001-fix/iterations/07/wiring",
  });
  assert.equal(iterationPaths(attempt, 100).root, "/a/001-fix/iterations/100");
});

const scratch = await mkdtemp(join(tmpdir(), "loopfile-attempt-"));

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * A run in progress: its event log so far, and the folder its attempts go in.
 *
 * Attempt IDs come from `nextAttemptId` over a replay of the log, which is how
 * the run owner gets them, so these tests check the count and the folders
 * together rather than each on its own. The log is written as lines and read
 * back through `parseEventLog`, the way a real run's is.
 */
function fakeRun(attemptsFolder: string) {
  const lines: string[] = [];

  function append(event: Record<string, unknown>): void {
    const seq = lines.length + 1;
    const at = new Date(Date.UTC(2026, 8, 18, 10, seq)).toISOString();
    lines.push(JSON.stringify({ seq, at, ...event }));
  }

  append({
    type: "run.created",
    runId: "r-1",
    eventFormatVersion: 1,
    modelDigest: "sha256:model",
    repositoryPath: "/home/me/project",
    baseCommit: "9f1c0de",
    branch: "loopfile/r-1",
    inputs: [],
  });

  return {
    attemptsFolder,

    /** Starts an attempt at `stepId`: its ID, its folder, and `attempt.started`. */
    async start(stepId: StepId): Promise<AttemptPaths> {
      const state = replay(parseEventLog(lines.map((line) => `${line}\n`).join("")));
      const attemptId = nextAttemptId(state, stepId);
      const paths = await createAttemptDirectory(attemptsFolder, attemptId);
      append({ type: "attempt.started", attemptId, stepId, processGroupId: 90 + lines.length });
      await writeFile(paths.stdout, `${attemptId} said something\n`);
      return paths;
    },

    end(attemptId: string): void {
      append({ type: "attempt.ended", attemptId, result: "success", reason: "clean_exit" });
    },

    interrupt(attemptId: string): void {
      append({ type: "attempt.interrupted", attemptId });
    },
  };
}

test("a run through implement, test, implement numbers the folders across the run", async () => {
  const run = fakeRun(join(scratch, "run-a", "attempts"));
  const names: string[] = [];
  for (const stepId of ["implement", "test", "implement"]) {
    const paths = await run.start(stepId);
    names.push(basename(paths.root));
    run.end(basename(paths.root));
  }

  assert.deepEqual(names, ["001-implement", "002-test", "003-implement"]);
  for (const name of names) {
    assert.ok(await exists(join(run.attemptsFolder, name, "scratch")));
    assert.ok(await exists(join(run.attemptsFolder, name, "wiring")));
    assert.ok(await exists(join(run.attemptsFolder, name, "data")));
  }
});

test("a resume after a crash makes a new folder and leaves the interrupted one alone", async () => {
  const run = fakeRun(join(scratch, "run-b", "attempts"));
  run.end(basename((await run.start("implement")).root));
  const crashed = await run.start("test");
  await writeFile(join(crashed.scratch, "half-written"), "partial");
  const before = await readFile(crashed.stdout, "utf8");

  // The resume replays the log, writes `attempt.interrupted`, and starts again.
  run.interrupt("002-test");
  const resumed = await run.start("test");

  assert.equal(basename(crashed.root), "002-test");
  assert.equal(basename(resumed.root), "003-test");
  assert.equal(await readFile(crashed.stdout, "utf8"), before);
  assert.equal(await readFile(join(crashed.scratch, "half-written"), "utf8"), "partial");
});

test("later attempts change nothing in an ended folder, and its output still reads", async () => {
  const run = fakeRun(join(scratch, "run-c", "attempts"));
  const first = await run.start("implement");
  await writeFile(join(first.data, "implement.notes"), "what attempt one found");
  run.end("001-implement");
  const ended = await stat(first.stdout);

  for (const stepId of ["test", "implement", "review"]) {
    run.end(basename((await run.start(stepId)).root));
  }

  const after = await stat(first.stdout);
  assert.equal(after.mtimeMs, ended.mtimeMs);
  assert.equal(after.size, ended.size);
  assert.equal(await readFile(first.stdout, "utf8"), "001-implement said something\n");
  assert.equal(
    await readFile(join(first.data, "implement.notes"), "utf8"),
    "what attempt one found",
  );
});

test("a folder that holds anything is never reused", async () => {
  const attempts = join(scratch, "run-d", "attempts");
  const first = await createAttemptDirectory(attempts, "001-fix");
  await writeFile(first.stdout, "what attempt one said\n");

  await assert.rejects(createAttemptDirectory(attempts, "001-fix"), (error: unknown) => {
    assert.ok(error instanceof RunDirectoryError);
    assert.match(error.message, /already exists: .*001-fix$/);
    return true;
  });
  assert.equal(await readFile(first.stdout, "utf8"), "what attempt one said\n");
});

test("output deep in a folder still counts as used", async () => {
  const attempts = join(scratch, "run-g", "attempts");
  const first = await createAttemptDirectory(attempts, "001-fix");
  await writeFile(join(first.scratch, "notes"), "left behind");

  await assert.rejects(createAttemptDirectory(attempts, "001-fix"), /already exists/);
});

test("a folder a crash left before attempt.started is taken over, not wedged on", async () => {
  // The folder is made before the event, and the number is counted from the
  // events, so a resume computes this same ID and must not fail on leftovers.
  const attempts = join(scratch, "run-h", "attempts");
  const orphan = await createAttemptDirectory(attempts, "001-fix");

  const resumed = await createAttemptDirectory(attempts, "001-fix");

  assert.equal(resumed.root, orphan.root);
  assert.ok(await exists(resumed.scratch));
  await writeFile(resumed.stdout, "the resumed attempt said something\n");
  assert.equal(await readFile(resumed.stdout, "utf8"), "the resumed attempt said something\n");
});

test("a folder that cannot be made for another reason keeps that reason", async () => {
  const run = join(scratch, "run-e");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "runs"), "a file where the run folder should go");
  await assert.rejects(
    createAttemptDirectory(join(run, "runs", "attempts"), "001-fix"),
    /cannot create \(ENOTDIR\): .*attempts$/,
  );
});

test("each Ralph iteration gets its own folder, and none is reused", async () => {
  const attempt = await createAttemptDirectory(join(scratch, "run-f", "attempts"), "001-fix");
  const first = await createIterationDirectory(attempt, 1);
  const second = await createIterationDirectory(attempt, 2);
  await writeFile(first.stdout, "iteration one\n");
  await writeFile(second.stdout, "iteration two\n");

  assert.ok(await exists(first.wiring));
  assert.ok(await exists(second.wiring));
  assert.equal(await readFile(first.stdout, "utf8"), "iteration one\n");
  await assert.rejects(createIterationDirectory(attempt, 1), /already exists: .*iterations\/01$/);
});

test("cleanup", async () => {
  await rm(scratch, { recursive: true, force: true });
});
