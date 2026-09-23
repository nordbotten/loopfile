import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEventLog, replay } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import { attemptPaths, createAttemptDirectory } from "./attempt-directory.ts";
import { appendedDataFile, DataStoreError, get, put } from "./data-store.ts";
import { openEventLog } from "./event-log.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-data-store-"));
let counter = 0;

/**
 * A run in progress: its real event log, the folder its attempts go in, and
 * the `history` array the data store reads its decisions from. Mirrors how
 * the run owner will hold both once it exists (#116): it appends other
 * lifecycle events itself and grows `history` with whatever `put`/`get`
 * appended, so the next call sees it.
 */
async function fakeRun() {
  counter += 1;
  const attemptsFolder = join(scratch, `run-${counter}`, "attempts");
  const inputsFolder = join(scratch, `run-${counter}`, "inputs");
  const events = await openEventLog(join(scratch, `run-${counter}.jsonl`));
  const history: RunEvent[] = [];

  async function append(fields: Record<string, unknown>): Promise<RunEvent> {
    const written = await events.append(fields as never);
    history.push(written);
    return written;
  }

  await append({
    type: "run.created",
    runId: `run-${counter}`,
    eventFormatVersion: 1,
    modelDigest: "sha256:model",
    targetFolder: "/home/me/project",
    baseCommit: "9f1c0de",
    branch: `loopfile/run-${counter}`,
    inputs: [],
  });

  return {
    attemptsFolder,
    inputsFolder,
    history,

    async start(attemptId: string, stepId: string): Promise<void> {
      await createAttemptDirectory(attemptsFolder, attemptId);
      await append({ type: "attempt.started", attemptId, stepId, processGroupId: 1 });
    },

    async end(attemptId: string): Promise<void> {
      await append({ type: "attempt.ended", attemptId, result: "success", reason: "clean_exit" });
    },

    /** Writes a launch input straight to `inputs/<name>`, the way the run owner does at start (#82). */
    async launchInput(name: string, content: string): Promise<void> {
      await mkdir(inputsFolder, { recursive: true });
      await writeFile(join(inputsFolder, name), content);
    },

    async put(
      attemptId: string,
      key: string,
      content: string,
      appended?: boolean,
    ): Promise<RunEvent> {
      const written = await put({
        events,
        history,
        attemptsFolder,
        attemptId,
        key,
        content: Buffer.from(content),
        appended,
      });
      history.push(written);
      return written;
    },

    async get(attemptId: string, key: string) {
      const result = await get({ events, history, attemptsFolder, inputsFolder, attemptId, key });
      history.push(result.event);
      return result;
    },

    async close(): Promise<void> {
      await events.close();
    },
  };
}

test("a put writes the value into the putting attempt's folder and appends data.put", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");

  const written = await run.put("001-review", "review.feedback", "looks good");

  assert.equal(written.type, "data.put");
  assert.equal((written as { attemptId: string }).attemptId, "001-review");
  assert.equal((written as { key: string }).key, "review.feedback");
  assert.equal((written as { size: number }).size, 10);
  assert.match((written as { digest: string }).digest, /^[0-9a-f]{64}$/);
  const onDisk = await readFile(
    join(attemptPaths(run.attemptsFolder, "001-review").data, "review.feedback"),
    "utf8",
  );
  assert.equal(onDisk, "looks good");
  await run.close();
});

test("a refused put writes no file and appends no event", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  const before = run.history.length;

  await assert.rejects(
    run.put("001-review", "implement.notes", "sneaky"),
    (error: unknown) => error instanceof DataStoreError && /own step/.test(error.message),
  );

  assert.equal(run.history.length, before);
  await assert.rejects(
    readFile(join(attemptPaths(run.attemptsFolder, "001-review").data, "implement.notes")),
  );
  await run.close();
});

test("an append marks the data.put event as appended, a plain put does not", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");

  const put = await run.put("001-review", "review.notes", "first note", true);
  assert.equal((put as { appended?: boolean }).appended, true);

  const plain = await run.put("001-review", "review.feedback", "verdict");
  assert.equal((plain as { appended?: boolean }).appended, undefined);
  await run.close();
});

test("two appends to the same key from the same attempt both keep their own bytes on disk", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");

  const first = await run.put("001-review", "review.notes", "first note", true);
  const second = await run.put("001-review", "review.notes", "second note", true);

  assert.equal((first as { writeIndex?: number }).writeIndex, 0);
  assert.equal((second as { writeIndex?: number }).writeIndex, 1);

  const latest = await run.get("002-implement", "review.notes");
  assert.equal(latest.content.toString(), "second note");

  const firstPath = join(attemptPaths(run.attemptsFolder, "001-review").data, "review.notes");
  assert.equal(await readFile(firstPath, "utf8"), "first note");
  assert.equal(
    await readFile(appendedDataFile(run.attemptsFolder, "review.notes"), "utf8"),
    "first note\nsecond note",
  );
  await run.close();
});

test("a put refuses a key an append already claimed, naming the command already used", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  await run.put("001-review", "review.notes", "first note", true);

  await assert.rejects(
    run.put("001-review", "review.notes", "sneaky plain write"),
    (error: unknown) =>
      error instanceof DataStoreError &&
      error.kind === "write_kind_mismatch" &&
      /data append/.test(error.message),
  );
  await run.close();
});

test("an append refuses a key a plain put already claimed, naming the command already used", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  await run.put("001-review", "review.feedback", "first pass");

  await assert.rejects(
    run.put("001-review", "review.feedback", "sneaky append", true),
    (error: unknown) =>
      error instanceof DataStoreError &&
      error.kind === "write_kind_mismatch" &&
      /data put/.test(error.message),
  );
  await run.close();
});

test("a put after the attempt ended is refused", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  await run.end("001-review");

  await assert.rejects(
    run.put("001-review", "review.feedback", "too late"),
    (error: unknown) => error instanceof DataStoreError && /ended/.test(error.message),
  );
  await run.close();
});

test("review puts review.feedback twice in two attempts: a later get returns the second, both files still exist", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  await run.put("001-review", "review.feedback", "first pass: changes requested");
  await run.end("001-review");

  await run.start("003-review", "review");
  await run.put("003-review", "review.feedback", "second pass: approved");
  await run.end("003-review");

  const read = await run.get("004-implement", "review.feedback");
  assert.equal(read.content.toString(), "second pass: approved");
  assert.equal(read.event.type, "data.get");
  assert.equal((read.event as { attemptId: string }).attemptId, "004-implement");

  assert.equal(
    await readFile(
      join(attemptPaths(run.attemptsFolder, "001-review").data, "review.feedback"),
      "utf8",
    ),
    "first pass: changes requested",
  );
  assert.equal(
    await readFile(
      join(attemptPaths(run.attemptsFolder, "003-review").data, "review.feedback"),
      "utf8",
    ),
    "second pass: approved",
  );
  await run.close();
});

test("a get of a key with no value gives a clear error naming the key", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");

  await assert.rejects(
    run.get("001-review", "review.feedback"),
    (error: unknown) =>
      error instanceof DataStoreError && error.message.includes("review.feedback"),
  );
  await run.close();
});

test("put and get events carry size and digest, and no content field", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  const putEvent = await run.put("001-review", "review.feedback", "abc");
  const { event: getEvent } = await run.get("002-implement", "review.feedback");

  for (const written of [putEvent, getEvent]) {
    assert.equal((written as { size: number }).size, 3);
    assert.match((written as { digest: string }).digest, /^[0-9a-f]{64}$/);
    assert.ok(!("content" in written));
  }
  await run.close();
});

test("after a restart, replay gives the same latest value a live run would", async () => {
  const run = await fakeRun();
  await run.start("001-review", "review");
  await run.put("001-review", "review.feedback", "first");
  await run.end("001-review");
  await run.start("003-review", "review");
  await run.put("003-review", "review.feedback", "second");
  await run.end("003-review");
  await run.close();

  const path = join(scratch, `run-${counter}.jsonl`);
  const resumedEvents = await openEventLog(path);
  const resumedHistory = [...parseEventLog(await readFile(path, "utf8"))];
  replay(resumedHistory); // the log still replays cleanly after the restart

  const read = await get({
    events: resumedEvents,
    history: resumedHistory,
    attemptsFolder: run.attemptsFolder,
    inputsFolder: run.inputsFolder,
    attemptId: "004-implement",
    key: "review.feedback",
  });
  assert.equal(read.content.toString(), "second");
  await resumedEvents.close();
});

test("a launch input reads under input.<name>, never through an attempt's data folder", async () => {
  const run = await fakeRun();
  await run.launchInput("task", "Prototype the reference manifest");
  await run.start("001-implement", "implement");

  const read = await run.get("001-implement", "input.task");

  assert.equal(read.content.toString(), "Prototype the reference manifest");
  assert.equal(read.event.type, "data.get");
  assert.equal((read.event as { key: string }).key, "input.task");
  await run.close();
});

test("no step can put under input, so a get of it always reads the launch input file", async () => {
  const run = await fakeRun();
  await run.launchInput("task", "first");
  await run.start("001-implement", "implement");

  await assert.rejects(
    run.put("001-implement", "input.task", "overwrite"),
    (error: unknown) => error instanceof DataStoreError && /reserved/.test(error.message),
  );
  const read = await run.get("001-implement", "input.task");
  assert.equal(read.content.toString(), "first");
  await run.close();
});

test("a get of an input name nothing wrote gives a clear error naming the key", async () => {
  const run = await fakeRun();
  await run.start("001-implement", "implement");

  await assert.rejects(
    run.get("001-implement", "input.missing"),
    (error: unknown) => error instanceof DataStoreError && error.message.includes("input.missing"),
  );
  await run.close();
});

test("cleanup", async () => {
  await rm(scratch, { recursive: true, force: true });
});
