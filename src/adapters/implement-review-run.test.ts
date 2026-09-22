/**
 * Runs examples/implement-review as committed, with the fake harness behind
 * the name `claude` (#44, #38). The target is a temp Git repository whose
 * `npm test` passes only when `out.txt` holds `fixed`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { promptDataView, renderPrompt } from "../application/prompt-fill.ts";
import { parseEventLog, replay } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import { dataFile } from "./data-store.ts";
import { type FakeAction, type FakeScript, fakeHarnessAdapters } from "./fake-harness.test.ts";
import { localExecutor } from "./local-executor.ts";
import { runPaths } from "./run-directory.ts";
import { executeRun } from "./workflow-run.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/implement-review", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const TASK = "Make out.txt hold the word fixed.";
const FEEDBACK = "Say why out.txt changed in the commit message.";

const run = promisify(execFile);
const gitEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-implement-review-")));
after(() => rm(root, { recursive: true, force: true }));
let count = 0;

/**
 * A target repository, a `loopfile` on `PATH` for the `test` step, and the
 * example run to its end with `script`.
 */
async function runExample(script: FakeScript) {
  count += 1;
  const dir = join(root, `case-${count}`);
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const runId = `20260919-120000-ir${count}`;
  await mkdir(repo, { recursive: true });
  await mkdir(bin);
  await writeFile(
    join(bin, "loopfile"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`,
  );
  await chmod(join(bin, "loopfile"), 0o755);
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ scripts: { test: "cat out.txt && grep -qx fixed out.txt" } })}\n`,
  );
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: gitEnv });
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: EXAMPLE,
    inputs: { task: TASK },
    repository: repo,
    executor: localExecutor({
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      npm_config_update_notifier: "false",
    }),
    adapters: fakeHarnessAdapters(script),
  });
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  return { ended, events, paths };
}

/** One `implement` iteration: keep the filled prompt beside the workspace, write out.txt, report done. */
function implement(call: number, content: string): FakeAction[] {
  return [
    { do: "savePrompt", path: `../prompts/implement-${call}.md` },
    { do: "write", path: "out.txt", content },
    { do: "result", outcome: "done" },
  ];
}

const changesRequested: FakeAction[] = [
  { do: "dataPut", key: "review.feedback", content: FEEDBACK },
  { do: "result", outcome: "changes_requested" },
];

function attemptIds(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) => (event.type === "attempt.started" ? [event.attemptId] : []));
}

test("the example goes test fail, fix, review changes, fix, approve, and hands data along", async () => {
  const { ended, events, paths } = await runExample({
    implement: [implement(1, "broken\n"), implement(2, "fixed\n"), implement(3, "fixed\n")],
    review: [changesRequested, [{ do: "result", outcome: "approved" }]],
  });
  assert.equal(ended.result, "success");

  assert.deepEqual(attemptIds(events), [
    "001-implement",
    "002-test",
    "003-implement",
    "004-test",
    "005-review",
    "006-implement",
    "007-test",
    "008-review",
  ]);
  // Structured results: every transition comes from an `on` route.
  assert.deepEqual(
    replay(events).transitions.map((t) => [t.from, t.to, t.cause]),
    [
      ["implement", "test", "on"],
      ["test", "implement", "on"],
      ["implement", "test", "on"],
      ["test", "review", "on"],
      ["review", "implement", "on"],
      ["implement", "test", "on"],
      ["test", "review", "on"],
      ["review", "$success", "on"],
    ],
  );

  // Shared worktree: `test` saw what each `implement` attempt wrote.
  const firstLog = await readFile(dataFile(paths.attempts, "002-test", "test.log"), "utf8");
  const secondLog = await readFile(dataFile(paths.attempts, "004-test", "test.log"), "utf8");
  assert.match(firstLog, /^broken$/m);
  assert.match(secondLog, /^fixed$/m);

  // Each `implement` attempt got the bytes put before it, filled into its prompt.
  const template = await readFile(join(EXAMPLE, "prompts/implement.md"), "utf8");
  const expected = (values: Record<string, string>) =>
    renderPrompt(
      template,
      promptDataView(new Map(Object.entries({ "input.task": TASK, ...values }))),
    );
  const prompt = (call: number) =>
    readFile(join(dirname(paths.workspace), "prompts", `implement-${call}.md`), "utf8");
  assert.equal(await prompt(1), expected({}));
  assert.equal(await prompt(2), expected({ "test.log": firstLog }));
  assert.equal(await prompt(3), expected({ "test.log": secondLog, "review.feedback": FEEDBACK }));
});

test("a review that never approves ends the run at $failure with attempt_limit", async () => {
  const { ended, events } = await runExample({
    implement: [1, 2, 3, 4, 5, 6].map((call) => implement(call, "fixed\n")),
    review: [1, 2, 3, 4, 5].map(() => changesRequested),
  });
  assert.equal(ended.result, "failure");
  const last = events.at(-1);
  assert.equal(last?.type === "run.ended" && last.reason, "attempt_limit");
  assert.equal(last?.type === "run.ended" && last.stepId, "test");
  // No step ran more attempts than its maxAttempts: implement 6, test and review 5.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(replay(events).attempts).map(([id, list]) => [id, list.length]),
    ),
    { implement: 6, test: 5, review: 5 },
  );
});
