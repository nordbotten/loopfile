import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { parseEventLog, replay } from "../application/replay.ts";
import { loadDirectory, loadPacked, loadThin } from "./directory-loader.ts";
import { type FakeScript, fakeHarnessAdapters } from "./fake-harness.test.ts";
import type { InputKind } from "./input.ts";
import { localExecutor } from "./local-executor.ts";
import { packCommand } from "./pack-command.ts";
import { runPaths } from "./run-directory.ts";
import { executeRun } from "./workflow-run.ts";

const run = promisify(execFile);
const gitEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-equivalence-")));
after(() => rm(root, { recursive: true, force: true }));

/** Inline prompts only: a thin `.loop` cannot use `promptFile` (#05). */
const manifestWith = (reviewPrompt: string) => `formatVersion: 1
steps:
  - id: implement
    kind: agent
    harness: claude
    prompt: Implement.
    on:
      done: review
  - id: review
    kind: agent
    harness: claude
    prompt: ${reviewPrompt}
    on:
      approved: $success
      changes_requested: implement
`;

const script: FakeScript = {
  implement: [[{ do: "result", outcome: "done" }], [{ do: "result", outcome: "done" }]],
  review: [
    [{ do: "result", outcome: "changes_requested" }],
    [{ do: "result", outcome: "approved" }],
  ],
};

interface Input {
  readonly kind: InputKind;
  readonly path: string;
}

let counter = 0;

/** The three input types for one manifest. The packed one is made by `pack`. */
async function makeInputs(manifest: string): Promise<Record<InputKind, Input>> {
  const base = join(root, `case-${counter++}`);
  const source = join(base, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "manifest.yaml"), manifest);
  const thin = join(base, "thin.loop");
  await writeFile(thin, manifest);
  const packed = join(base, "packed.loop");
  let err = "";
  const code = await packCommand(
    ["pack", source, "-o", packed],
    () => {},
    (text) => {
      err += text;
    },
  );
  assert.equal(code, 0, err);
  return {
    directory: { kind: "directory", path: source },
    thin: { kind: "thin", path: thin },
    packed: { kind: "packed", path: packed },
  };
}

async function load({ kind, path }: Input) {
  const result = await (kind === "directory"
    ? loadDirectory(path)
    : kind === "thin"
      ? loadThin(path)
      : loadPacked(path));
  assert.equal(result.status, "loaded");
  return result.status === "loaded" ? result.workflow : assert.fail("not loaded");
}

/** Runs one input with the fake harness and returns what a replay says, without ids or times. */
async function runInput({ kind, path }: Input) {
  const repo = join(root, `repo-${counter++}`);
  const home = join(root, `home-${counter++}`);
  const runId = "20260919-120000-eq";
  await mkdir(repo);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await writeFile(join(repo, "file.txt"), "x");
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: gitEnv });
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  const ended = await executeRun({
    home,
    runId,
    source: path,
    sourceKind: kind,
    repository: repo,
    executor: localExecutor(),
    adapters: fakeHarnessAdapters(script),
  });
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  const state = replay(events);
  const created = events.find((event) => event.type === "run.created");
  return {
    result: ended.result,
    digest: created?.type === "run.created" ? created.modelDigest : undefined,
    attempts: Object.fromEntries(
      Object.entries(state.attempts).map(([id, list]) => [id, list.length]),
    ),
    started: events.flatMap((event) => (event.type === "attempt.started" ? [event.attemptId] : [])),
    transitions: state.transitions.map((t) => [t.from, t.to, t.cause]),
    prompts: await promptFiles(paths.prompts),
  };
}

/** The model holds prompt paths, not text (ADR 0002), so the run's prompt files carry the text. */
async function promptFiles(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(directory, name), "utf8")] as const),
    ),
  );
}

const KINDS: readonly InputKind[] = ["directory", "thin", "packed"];

test("a directory, a thin .loop and a packed .loop build the same model", async () => {
  const inputs = await makeInputs(manifestWith("Review."));
  const models = await Promise.all(KINDS.map((kind) => load(inputs[kind])));
  assert.deepEqual(models[1], models[0]);
  assert.deepEqual(models[2], models[0]);
});

test("the three input types run to the same digest, steps, attempts, transitions and result", async () => {
  const inputs = await makeInputs(manifestWith("Review."));
  const [directory, thin, packed] = await Promise.all(KINDS.map((kind) => runInput(inputs[kind])));
  assert.equal(directory?.result, "success");
  assert.deepEqual(directory?.attempts, { implement: 2, review: 2 });
  assert.deepEqual(directory?.started, [
    "001-implement",
    "002-review",
    "003-implement",
    "004-review",
  ]);
  assert.deepEqual(directory?.transitions, [
    ["implement", "review", "on"],
    ["review", "implement", "on"],
    ["implement", "review", "on"],
    ["review", "$success", "on"],
  ]);
  assert.match(directory?.digest ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(thin, directory);
  assert.deepEqual(packed, directory);
});

test("one changed prompt in one input type makes the run comparison fail", async () => {
  const inputs = await makeInputs(manifestWith("Review."));
  const changed = await makeInputs(manifestWith("Review harder."));
  const base = await runInput(inputs.directory);
  for (const kind of KINDS) {
    const other = await runInput(changed[kind]);
    assert.deepEqual(base.prompts, { "implement.md": "Implement.", "review.md": "Review." });
    assert.notDeepEqual(other, base, kind);
    assert.equal(other.prompts["review.md"], "Review harder.", kind);
  }
});

test("one changed route in one input type changes the model and the digest", async () => {
  const inputs = await makeInputs(manifestWith("Review."));
  const changed = await makeInputs(
    manifestWith("Review.").replace("changes_requested: implement", "changes_requested: $failure"),
  );
  const base = await runInput(inputs.directory);
  for (const kind of KINDS) {
    assert.notDeepEqual(await load(changed[kind]), await load(inputs.directory), kind);
    // Only the digest is read here: the run itself may end another way.
    const digest = await runInput(changed[kind]).then((r) => r.digest);
    assert.notEqual(digest, base.digest, kind);
  }
});
