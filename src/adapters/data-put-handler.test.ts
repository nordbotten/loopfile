import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../application/data-store.ts";
import { parseEventLog } from "../application/replay.ts";
import type { AttemptId } from "../domain/model.ts";
import { dataAppend, dataPut } from "./attempt-client.ts";
import { attemptPaths, createAttemptDirectory } from "./attempt-directory.ts";
import { dataPutHandler } from "./data-put-handler.ts";
import { type RunPaths, runPaths } from "./run-directory.ts";
import { type RunOwner, startRunOwner } from "./run-owner.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-data-put-"));
let counter = 0;

interface Rig {
  readonly owner: RunOwner;
  readonly paths: RunPaths;
}

async function newRig(): Promise<Rig> {
  counter += 1;
  const home = join(scratch, `home-${counter}`);
  const runId = `20260917-160344-r${counter}`;
  await mkdir(runPaths(home, runId).root, { recursive: true });
  const owner = await startRunOwner({ home, runId, probeTimeoutMs: 250 });
  return { owner, paths: owner.paths };
}

async function startAttempt(rig: Rig, attemptId: AttemptId, stepId: string): Promise<void> {
  await createAttemptDirectory(rig.paths.attempts, attemptId);
  await rig.owner.events.append({ type: "attempt.started", attemptId, stepId, processGroupId: 1 });
}

/**
 * Serves `attemptId`'s socket with a `data put`/`data append` handler wired
 * to `rig`. Its `history` reads the event log fresh from disk on every call,
 * the way a real run owner would (#116), so the wire tests below can make
 * more than one call per attempt and have the second call see the first's
 * event without a second, in-memory copy of the log to keep in step.
 */
async function serveDataPut(rig: Rig, attemptId: AttemptId, secret: string, iteration?: number) {
  const socketPath = join(rig.paths.attempts, attemptId, "sock");
  const endpoint = await rig.owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId, secret, iteration }),
    handle: dataPutHandler({
      events: rig.owner.events,
      attemptsFolder: rig.paths.attempts,
      history: () => parseEventLog(readFileSync(rig.paths.events, "utf8")),
    }),
  });
  return { socketPath, endpoint };
}

test("a put writes the content and reports its size and digest", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const content = Buffer.from("looks good");
  const report = await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review.feedback",
    content,
  );

  assert.ok(report.ok);
  assert.equal(report.summary, "put review.feedback");
  assert.equal(report.fields?.bytes, String(content.byteLength));
  assert.equal(report.fields?.digest, sha256(content));
  const onDisk = await readFile(
    join(attemptPaths(rig.paths.attempts, "001-review").data, "review.feedback"),
  );
  assert.deepEqual(onDisk, content);
});

test("binary content round-trips through the base64 wire byte for byte", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const bytes = Buffer.from(Uint8Array.from([0, 1, 2, 9, 10, 13, 253, 254, 255]));
  await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review.blob",
    bytes,
  );

  const onDisk = await readFile(
    join(attemptPaths(rig.paths.attempts, "001-review").data, "review.blob"),
  );
  assert.deepEqual(onDisk, bytes);
});

test("changing the source buffer after the put does not change the stored value", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const content = Buffer.from("original");
  await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review.feedback",
    content,
  );
  content.fill(0);

  const onDisk = await readFile(
    join(attemptPaths(rig.paths.attempts, "001-review").data, "review.feedback"),
    "utf8",
  );
  assert.equal(onDisk, "original");
});

test("an append marks the event as appended, so a later append on the same key is allowed", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const env = { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" };
  const first = await dataAppend(env, "review.notes", "first");
  assert.ok(first.ok);
  const second = await dataAppend(env, "review.notes", "second");
  assert.ok(second.ok);

  const events = parseEventLog(await readFile(rig.paths.events, "utf8"));
  const puts = events.filter((event) => event.type === "data.put");
  assert.equal(puts.length, 2);
  assert.ok(puts.every((event) => (event as { appended?: boolean }).appended === true));
});

test("a put on a key an append already claimed is refused as write_kind_mismatch", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const env = { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" };
  await dataAppend(env, "review.notes", "first");
  const report = await dataPut(env, "review.notes", Buffer.from("overwrite"));

  assert.ok(!report.ok);
  assert.equal(report.code, "write_kind_mismatch");
  assert.match(report.summary, /data append/);
});

test("an append on a key a put already claimed is refused as write_kind_mismatch", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const env = { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" };
  await dataPut(env, "review.feedback", Buffer.from("first pass"));
  const report = await dataAppend(env, "review.feedback", "sneaky append");

  assert.ok(!report.ok);
  assert.equal(report.code, "write_kind_mismatch");
  assert.match(report.summary, /data put/);
});

test("a put under another step's namespace is refused as invalid_key", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const report = await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "implement.notes",
    Buffer.from("sneaky"),
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "invalid_key");
});

test("a put under input is refused as invalid_key", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const report = await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "input.task",
    Buffer.from("sneaky"),
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "invalid_key");
});

test("a put with a malformed name is refused as invalid_key", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const report = await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review",
    Buffer.from("no dot"),
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "invalid_key");
});

test("a put from an ended attempt is refused as stale_attempt", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  await rig.owner.events.append({
    type: "attempt.ended",
    attemptId: "001-review",
    result: "success",
    reason: "clean_exit",
  });
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  const report = await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review.feedback",
    Buffer.from("too late"),
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("a call from an ended Ralph iteration is refused as stale_attempt", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-implement", "implement");
  const { socketPath, endpoint } = await serveDataPut(
    rig,
    "001-implement",
    "iteration-2-secret",
    2,
  );
  t.after(() => endpoint.close());

  const report = await dataPut(
    {
      endpoint: socketPath,
      attemptId: "001-implement",
      secret: "iteration-1-secret",
      iteration: 1,
    },
    "implement.progress",
    Buffer.from("stale"),
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("a call with no run owner to answer fails with a clear, unfixable error", async () => {
  const report = await dataPut(
    { endpoint: join(scratch, "no-such-socket"), attemptId: "001-x", secret: "s" },
    "x.y",
    Buffer.from("x"),
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("each put appears as an event with size and digest and no content", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveDataPut(rig, "001-review", "s3cret");
  t.after(() => endpoint.close());

  await dataPut(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "review.feedback",
    Buffer.from("looks good"),
  );

  const events = parseEventLog(await readFile(rig.paths.events, "utf8"));
  const put = events.find((event) => event.type === "data.put");
  assert.ok(put);
  assert.equal(put.type, "data.put");
  assert.equal(put.key, "review.feedback");
  assert.equal(put.size, 10);
  assert.ok(put.digest.length > 0);
  assert.ok(!("content" in put), "an event never holds content");
});

test.after(() => rm(scratch, { recursive: true, force: true }));
