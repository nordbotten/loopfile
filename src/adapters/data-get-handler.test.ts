import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEventLog } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId } from "../domain/model.ts";
import { dataGet } from "./attempt-client.ts";
import { createAttemptDirectory } from "./attempt-directory.ts";
import { dataGetHandler } from "./data-get-handler.ts";
import { put } from "./data-store.ts";
import { type RunPaths, runPaths } from "./run-directory.ts";
import { type RunOwner, startRunOwner } from "./run-owner.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-data-get-"));
let counter = 0;

/**
 * A run owner plus the events appended so far, kept alongside it because the
 * only writer of `events.jsonl` never hands back what it holds (ADR 0003):
 * every helper below pushes what it appends, the way a real run owner's own
 * in-memory state would (#116).
 */
interface Rig {
  readonly owner: RunOwner;
  readonly paths: RunPaths;
  readonly history: RunEvent[];
}

async function newRig(): Promise<Rig> {
  counter += 1;
  const home = join(scratch, `home-${counter}`);
  const runId = `20260917-160344-r${counter}`;
  await mkdir(runPaths(home, runId).root, { recursive: true });
  const owner = await startRunOwner({ home, runId, probeTimeoutMs: 250 });
  return { owner, paths: owner.paths, history: [] };
}

async function startAttempt(rig: Rig, attemptId: AttemptId, stepId: string): Promise<void> {
  await createAttemptDirectory(rig.paths.attempts, attemptId);
  rig.history.push(
    await rig.owner.events.append({
      type: "attempt.started",
      attemptId,
      stepId,
      processGroupId: 1,
    }),
  );
}

async function putKey(
  rig: Rig,
  attemptId: AttemptId,
  key: string,
  content: Uint8Array,
): Promise<void> {
  const event = await put({
    events: rig.owner.events,
    history: rig.history,
    attemptsFolder: rig.paths.attempts,
    attemptId,
    key,
    content,
  });
  rig.history.push(event);
}

/** Serves `attemptId`'s socket with a `data get` handler wired to `rig`. */
async function serveDataGet(rig: Rig, attemptId: AttemptId, secret: string, iteration?: number) {
  const socketPath = join(rig.paths.attempts, attemptId, "sock");
  const endpoint = await rig.owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId, secret, iteration }),
    handle: dataGetHandler({
      events: rig.owner.events,
      attemptsFolder: rig.paths.attempts,
      inputsFolder: rig.paths.inputs,
      history: () => rig.history,
    }),
  });
  return { socketPath, endpoint };
}

test("a step reads a value another step put, with no storage path known to it", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-implement", "implement");
  await putKey(rig, "001-implement", "implement.review", Buffer.from("please review this"));
  await startAttempt(rig, "002-review", "review");

  const { socketPath, endpoint } = await serveDataGet(rig, "002-review", "s3cret");
  t.after(() => endpoint.close());

  const { report, content } = await dataGet(
    { endpoint: socketPath, attemptId: "002-review", secret: "s3cret" },
    "implement.review",
  );

  assert.equal(content?.toString(), "please review this");
  assert.ok(report.ok);
  assert.equal(report.summary, "read implement.review");
  assert.equal(report.fields?.attempt, "001-implement");
  assert.equal(report.fields?.bytes, "18");
});

test("binary content round-trips byte for byte", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  const bytes = Uint8Array.from([0, 1, 2, 9, 10, 13, 253, 254, 255]);
  await startAttempt(rig, "001-implement", "implement");
  await putKey(rig, "001-implement", "implement.blob", bytes);
  await startAttempt(rig, "002-review", "review");

  const { socketPath, endpoint } = await serveDataGet(rig, "002-review", "s3cret");
  t.after(() => endpoint.close());

  const { content } = await dataGet(
    { endpoint: socketPath, attemptId: "002-review", secret: "s3cret" },
    "implement.blob",
  );
  assert.deepEqual(content ? new Uint8Array(content) : undefined, bytes);
});

test("launch inputs are readable as input.<name>", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await mkdir(rig.paths.inputs, { recursive: true });
  await writeFile(join(rig.paths.inputs, "task"), "fix the login bug");
  await startAttempt(rig, "001-review", "review");

  const { socketPath, endpoint } = await serveDataGet(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const { report, content } = await dataGet(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "input.task",
  );
  assert.equal(content?.toString(), "fix the login bug");
  assert.ok(report.ok);
  assert.equal(report.fields?.attempt, undefined, "a launch input has no putting attempt");
});

test("a key with no value exits non-zero with an error that names the key", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataGet(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const { report } = await dataGet(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review.nope",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "unknown_key");
  assert.match(report.summary, /review\.nope/);
});

test("a call with a wrong or old attempt secret is refused", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-implement", "implement");
  await putKey(rig, "001-implement", "implement.review", Buffer.from("x"));
  await startAttempt(rig, "002-review", "review");

  const { socketPath, endpoint } = await serveDataGet(rig, "002-review", "current-secret");
  t.after(() => endpoint.close());

  const { report } = await dataGet(
    { endpoint: socketPath, attemptId: "002-review", secret: "guessed" },
    "implement.review",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("a call from an ended Ralph iteration is refused", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-implement", "implement");
  const { socketPath, endpoint } = await serveDataGet(
    rig,
    "001-implement",
    "iteration-2-secret",
    2,
  );
  t.after(() => endpoint.close());

  // Iteration 1's process, still holding its own (now stale) secret.
  const { report } = await dataGet(
    {
      endpoint: socketPath,
      attemptId: "001-implement",
      secret: "iteration-1-secret",
      iteration: 1,
    },
    "implement.progress",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("a call with no run owner to answer fails with a clear, unfixable error", async () => {
  const { report } = await dataGet(
    { endpoint: join(scratch, "no-such-socket"), attemptId: "001-x", secret: "s" },
    "x.y",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("each read appears as an event with size and digest and no content", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-implement", "implement");
  await putKey(rig, "001-implement", "implement.review", Buffer.from("please review this"));
  await startAttempt(rig, "002-review", "review");

  const { socketPath, endpoint } = await serveDataGet(rig, "002-review", "s3cret");
  t.after(() => endpoint.close());

  await dataGet(
    { endpoint: socketPath, attemptId: "002-review", secret: "s3cret" },
    "implement.review",
  );

  const events = parseEventLog(await readFile(rig.paths.events, "utf8"));
  const got = events.find((event) => event.type === "data.get");
  assert.ok(got);
  assert.equal(got.type, "data.get");
  assert.equal(got.key, "implement.review");
  assert.equal(got.size, 18);
  assert.ok(got.digest.length > 0);
  assert.ok(!("content" in got), "an event never holds content");
});

test.after(() => rm(scratch, { recursive: true, force: true }));
