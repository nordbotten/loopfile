import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { parseEventLog, replay } from "../application/replay.ts";
import { type FakeScript, fakeHarnessAdapters } from "./fake-harness.test.ts";
import { localExecutor } from "./local-executor.ts";
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

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-feedback-")));
after(() => rm(root, { recursive: true, force: true }));

const MANIFEST = `formatVersion: 1
steps:
  - id: implement
    kind: agent
    harness: claude
    prompt: Implement.
    on:
      done: tests
  - id: tests
    kind: command
    run: ./check.sh
    onFailure: implement
  - id: review
    kind: agent
    harness: claude
    prompt: Review.
    outputs:
      feedback: [changes_requested]
    on:
      approved: $success
      changes_requested: implement
`;

/**
 * Passes when `out.txt` holds `fixed`. The run's worktree is removed when the
 * run succeeds, so each call also logs what the workspace holds, one line per
 * call, to `check.log` beside the workspace.
 */
const CHECK_SH = `#!/bin/sh
read_or_none() { if [ -f "$1" ]; then cat "$1"; else printf none; fi; }
printf '%s|%s|%s|%s\\n' "$(read_or_none first.txt)" "$(read_or_none fix.txt)" \\
  "$(read_or_none feedback.txt)" "$(read_or_none out.txt)" >> ../check.log
[ "$(cat out.txt)" = fixed ]
`;

const FEEDBACK = "add a newline";

const script: FakeScript = {
  implement: [
    [
      { do: "write", path: "out.txt", content: "broken" },
      { do: "write", path: "first.txt", content: "from-001" },
      { do: "result", outcome: "done" },
    ],
    [
      { do: "write", path: "out.txt", content: "fixed" },
      { do: "write", path: "fix.txt", content: "from-003" },
      { do: "result", outcome: "done" },
    ],
    [
      { do: "dataGet", key: "review.feedback", to: "feedback.txt" },
      { do: "write", path: "out.txt", content: "fixed\n" },
      { do: "result", outcome: "done" },
    ],
  ],
  review: [
    [
      { do: "dataPut", key: "review.feedback", content: FEEDBACK },
      { do: "result", outcome: "changes_requested" },
    ],
    [{ do: "result", outcome: "approved" }],
  ],
};

test("a workflow that cycles keeps its workspace and hands data between attempts", async () => {
  const repo = join(root, "repo");
  const source = join(root, "source");
  const home = join(root, "home");
  const runId = "20260919-120000-fl";
  await mkdir(repo);
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await writeFile(join(repo, "check.sh"), CHECK_SH);
  await chmod(join(repo, "check.sh"), 0o755);
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: gitEnv });
  await writeFile(join(source, "manifest.yaml"), MANIFEST);
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(),
    adapters: fakeHarnessAdapters(script),
  });
  assert.equal(ended.result, "success");

  const events = parseEventLog(await readFile(paths.events, "utf8"));
  const state = replay(events);
  assert.deepEqual(
    Object.fromEntries(Object.entries(state.attempts).map(([id, list]) => [id, list.length])),
    { implement: 3, tests: 3, review: 2 },
  );
  assert.deepEqual(
    events.flatMap((event) => (event.type === "attempt.started" ? [event.attemptId] : [])),
    [
      "001-implement",
      "002-tests",
      "003-implement",
      "004-tests",
      "005-review",
      "006-implement",
      "007-tests",
      "008-review",
    ],
  );
  assert.deepEqual(
    state.transitions.map((t) => [t.from, t.to, t.cause]),
    [
      ["implement", "tests", "on"],
      ["tests", "implement", "onFailure"],
      ["implement", "tests", "on"],
      ["tests", "review", "next"],
      ["review", "implement", "on"],
      ["implement", "tests", "on"],
      ["tests", "review", "next"],
      ["review", "$success", "on"],
    ],
  );

  // One log line per `tests` call: first.txt|fix.txt|feedback.txt|out.txt.
  const log = (await readFile(join(dirname(paths.workspace), "check.log"), "utf8")).split("\n");
  assert.deepEqual(log, [
    "from-001|none|none|broken", // 001's file is there for 002, and so for 003
    "from-001|from-003|none|fixed", // 001's and 003's files are there for 004
    `from-001|from-003|${FEEDBACK}|fixed`, // 006 read the bytes 005 put; out.txt is "fixed\n"
    "",
  ]);

  const put = events.find((event) => event.type === "data.put");
  const get = events.find((event) => event.type === "data.get");
  assert.equal(put?.type === "data.put" && put.attemptId, "005-review");
  assert.equal(get?.type === "data.get" && get.attemptId, "006-implement");
  assert.equal(get?.type === "data.get" && get.key, "review.feedback");
  assert.equal(get?.type === "data.get" && get.size, FEEDBACK.length);
  assert.equal(
    get?.type === "data.get" && get.digest,
    put?.type === "data.put" ? put.digest : undefined,
  );
});
