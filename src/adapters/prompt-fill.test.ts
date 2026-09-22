import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../application/data-store.ts";
import type { RunEvent } from "../domain/events.ts";
import { dataFile } from "./data-store.ts";
import { fillPromptForCall } from "./prompt-fill.ts";

const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function rig() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-fill-")));
  folders.push(root);
  const attemptsFolder = join(root, "attempts");
  const inputsFolder = join(root, "inputs");
  await mkdir(inputsFolder);
  const history: RunEvent[] = [];
  const appended: RunEvent[] = [];
  const options = {
    events: {
      append: async (event: object) => {
        const stored = { ...event, seq: 1, at: "t" } as RunEvent;
        appended.push(stored);
        return stored;
      },
    },
    history: () => history,
    attemptsFolder,
    inputsFolder,
  };
  const write = async (
    attemptId: string,
    key: string,
    content: string,
    writeIndex?: number,
    appendedKey = false,
  ) => {
    const path = dataFile(attemptsFolder, attemptId, key, writeIndex);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    history.push({
      type: "data.put",
      attemptId,
      key,
      size: 1,
      digest: "d",
      seq: history.length + 1,
      at: "t",
      ...(appendedKey ? { appended: true, writeIndex } : {}),
    } as RunEvent);
  };
  return { options, appended, history, write, inputsFolder };
}

const call = { attemptId: "003-impl", stepId: "impl", startedAt: "started" };

test("an appended key with three values, two from one attempt, joins them with newlines", async () => {
  const { options, appended, write } = await rig();
  await write("001-review", "review.notes", "v1", 0, true);
  await write("001-review", "review.notes", "v2", 1, true);
  await write("002-review", "review.notes", "v3", 0, true);
  const text = await fillPromptForCall(options, call, "notes:\n{{ review.notes }}\nend");
  assert.equal(text, "notes:\nv1\nv2\nv3\nend");
  assert.equal(appended.length, 1);
});

test("history keeps every append and records each write index", async () => {
  const { options, appended, write } = await rig();
  await write("001-review", "review.feedback", "first", 0, true);
  await write("001-review", "review.feedback", "second", 1, true);

  const text = await fillPromptForCall(
    options,
    call,
    "{{#each $history.review.feedback}}[{{value}}|{{attemptId}}|{{index}}|{{newest}}]{{/each}}",
  );
  assert.equal(text, "[first|001-review|1|false][second|001-review|2|true]");
  assert.deepEqual(appended[0]?.type === "prompt.filled" && appended[0].reads, {
    values: {
      "review.feedback": [
        { kind: "attempt", attemptId: "001-review", writeIndex: 0 },
        { kind: "attempt", attemptId: "001-review", writeIndex: 1 },
      ],
    },
  });
});

test("history keeps one entry for a plain key put twice by one attempt", async () => {
  const { options, write } = await rig();
  await write("001-review", "review.feedback", "first");
  await write("001-review", "review.feedback", "second");

  const text = await fillPromptForCall(
    options,
    call,
    "{{#each $history.review.feedback}}[{{value}}|{{attemptId}}|{{index}}|{{newest}}]{{/each}}",
  );
  assert.equal(text, "[second|001-review|1|true]");
});

test("a block reads every value under its map prefix", async () => {
  const { options, write, inputsFolder } = await rig();
  await write("001-review", "review.feedback", "yes");
  await writeFile(join(inputsFolder, "topic"), "input-value");
  const text = await fillPromptForCall(
    options,
    call,
    "{{#each review}}{{this}}{{/each}}|{{#if review}}shown{{/if}}|{{#if review.feedback}}feedback{{/if}}",
  );
  assert.equal(text, "yes|shown|feedback");
  assert.equal(
    await fillPromptForCall(options, call, "{{#if review.feedback}}feedback{{/if}}"),
    "feedback",
  );
  assert.equal(await fillPromptForCall(options, call, "{{#if input}}shown{{/if}}"), "shown");
});

test("the event records the keys, the digest of the filled text and the iteration", async () => {
  const { options, appended, write, inputsFolder } = await rig();
  await write("001-review", "review.feedback", "old");
  await write("002-review", "review.feedback", "new");
  await writeFile(join(inputsFolder, "topic"), "héllo");
  const text = await fillPromptForCall(
    options,
    { ...call, iteration: 2 },
    "{{ review.feedback }} {{ input.topic }} {{ review.none }}",
  );
  assert.equal(text, "new héllo ");
  const [event] = appended;
  assert.deepEqual(event, {
    type: "prompt.filled",
    attemptId: "003-impl",
    stepId: "impl",
    iteration: 2,
    keys: { "review.feedback": true, "input.topic": true, "review.none": false },
    size: Buffer.byteLength(text, "utf8"),
    digest: sha256(Buffer.from(text, "utf8")),
    seq: 1,
    at: "t",
  });
});

test("a step that is not Ralph records no iteration", async () => {
  const { options, appended } = await rig();
  await fillPromptForCall(options, call, "{{ input.x }}");
  assert.equal(appended[0] && "iteration" in appended[0], false);
});

test("an input with no file, and a put whose file is gone, fill as empty", async () => {
  const { options, appended, write } = await rig();
  await write("001-review", "review.feedback", "x");
  await rm(dataFile(options.attemptsFolder, "001-review", "review.feedback"));
  const text = await fillPromptForCall(options, call, "[{{ input.x }}][{{ review.feedback }}]");
  assert.equal(text, "[][]");
  assert.deepEqual(appended[0]?.type === "prompt.filled" && appended[0].keys, {
    "input.x": false,
    "review.feedback": false,
  });
});

test("a history loop fills every value and records the sources it read", async () => {
  const { options, appended, history, write } = await rig();
  history.push({
    type: "attempt.started",
    attemptId: "001-impl",
    stepId: "impl",
    processGroupId: 1,
    seq: 1,
    at: "t",
  });
  await write("002-review", "review.feedback", "old");
  history.push({
    type: "attempt.ended",
    attemptId: "002-review",
    result: "success",
    reason: "outcome",
    outcome: "changes_requested",
    seq: 3,
    at: "t",
  });
  history.push({
    type: "attempt.started",
    attemptId: "003-impl",
    stepId: "impl",
    processGroupId: 1,
    seq: 4,
    at: "t",
  });
  await write("004-review", "review.feedback", "new");

  const text = await fillPromptForCall(
    options,
    { attemptId: "005-impl", stepId: "impl", startedAt: "started" },
    "{{#each $history.review.feedback}}[{{ value }}|{{ attemptId }}|{{ outcome }}|{{ index }}|{{ newest }}|{{ new }}]{{/each}}",
  );
  assert.equal(
    text,
    "[old|002-review|changes_requested|1|false|false][new|004-review||2|true|true]",
  );
  assert.deepEqual(appended[0]?.type === "prompt.filled" && appended[0].reads, {
    values: {
      "review.feedback": [
        { kind: "attempt", attemptId: "002-review" },
        { kind: "attempt", attemptId: "004-review" },
      ],
    },
  });
});

test("an input history has one indexed newest entry", async () => {
  const { options, appended, inputsFolder } = await rig();
  await writeFile(join(inputsFolder, "topic"), "input-value");
  const text = await fillPromptForCall(
    options,
    call,
    "{{#each $history.input.topic}}[{{ value }}|{{ attemptId }}|{{ outcome }}|{{ index }}|{{ newest }}]{{/each}}",
  );
  assert.equal(text, "[input-value|||1|true]");
  assert.deepEqual(appended[0]?.type === "prompt.filled" && appended[0].reads, {
    values: { "input.topic": [{ kind: "input", name: "topic" }] },
  });
});

test("a prompt with no placeholders is returned as it is and appends no event", async () => {
  const { options, appended } = await rig();
  assert.equal(await fillPromptForCall(options, call, "just text {x}"), "just text {x}");
  assert.deepEqual(appended, []);
});

test("a read error other than a missing file is thrown", async () => {
  const { options, write } = await rig();
  await write("001-review", "review.feedback", "x");
  // A folder where the value file should be: reading it fails with EISDIR.
  const path = dataFile(options.attemptsFolder, "001-review", "review.feedback");
  await rm(path);
  await mkdir(path);
  await assert.rejects(fillPromptForCall(options, call, "{{ review.feedback }}"), /EISDIR/);
});
