import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type FakeAction, type FakeScript, fakeHarnessAdapters } from "./fake-harness.test.ts";
import { localExecutor } from "./local-executor.ts";
import { runPaths } from "./run-directory.ts";
import { executeRun } from "./workflow-run.ts";

const run = promisify(execFile);
const TICKET = fileURLToPath(new URL("../../loops/ticket", import.meta.url));
const TASK = "#273 Fix the fixer prompt";
const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-ticket-")));
after(() => rm(root, { recursive: true, force: true }));

const gitEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
}

function fixPrompt(number: number, why: string, handled = ""): string {
  return `You were implementing the GitHub issue below. The work is committed on the current
branch. A check of that work came back with problems. Fix those problems. Do not
start the issue again.

This is fix visit ${number} of at most 5.

## The issue

${TASK}

## Why you are here

${why}

## Feedback you already handled

An earlier fix visit handled each item below. Do not work on it again. It is here
so that you know what was asked before and do not undo it.${handled}

## What to do

1. Read \`git log origin/main..HEAD\` and \`git diff origin/main...HEAD\` to see the work so far.
2. Fix only what "Why you are here" asks for. If it is a bug, write a failing test first.
3. Do not change anything else. If you see another problem, name it in your commit
   message and leave it.
4. Follow AGENTS.md. Do not add a suppression under \`src/\`, and do not edit a bar in
   \`quality/quality-ratchet.json\`.
5. Commit your fix to the current branch. Do not push and do not open a pull request.
6. Run \`loopfile result done\`. If you cannot go on without a person, run
   \`loopfile result blocked --message "<why>"\`.
`;
}

/** Runs the ticket Loopfile through its three routes back to fix. */
test("the ticket fixer prompt names its sender and only earlier feedback", async () => {
  const repo = join(root, "repo");
  const bare = join(root, "origin.git");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const runId = "20260921-120000-ticket";
  const npmCount = join(root, "npm-count");
  const ghCount = join(root, "gh-count");
  const pr = join(root, "pr");
  await mkdir(repo);
  await mkdir(bin);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await writeFile(join(repo, "README.md"), "ticket test\n");
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: gitEnv });
  await run("git", ["init", "-q", "--bare", bare], { env: gitEnv });
  await run("git", ["remote", "add", "origin", bare], { cwd: repo, env: gitEnv });
  await executable(
    join(bin, "npm"),
    `if [ "$1" = ci ]; then exit 0; fi
if [ "$1" = run ] && [ "$2" = gate:quiet ]; then
  n=$(cat ${JSON.stringify(npmCount)} 2>/dev/null || printf 0)
  n=$((n + 1))
  printf %s "$n" > ${JSON.stringify(npmCount)}
  if [ "$n" = 1 ]; then printf 'test failure\n'; exit 1; fi
fi
printf 'check passed\n'
`,
  );
  await executable(
    join(bin, "gh"),
    `case "$1 $2" in
  "pr view") test -f ${JSON.stringify(pr)} ;;
  "issue view") printf 'Ticket title\n' ;;
  "pr create") touch ${JSON.stringify(pr)} ;;
  "pr edit") ;;
  "pr checks")
    if [ "$3" = --watch ]; then
      n=$(cat ${JSON.stringify(ghCount)} 2>/dev/null || printf 0)
      n=$((n + 1))
      printf %s "$n" > ${JSON.stringify(ghCount)}
      if [ "$n" = 1 ]; then printf 'CI failure\n'; exit 1; fi
    else
      printf 'checks registered\n'
    fi
    ;;
  "run list") printf '1\n' ;;
  "run view") printf 'CI failure\n' ;;
esac
`,
  );

  const saveFix = (number: number): FakeAction[] => [
    { do: "savePrompt", path: `../fix-${number}.md` },
    { do: "result", outcome: "done" },
  ];
  const script: FakeScript = {
    implement: [[{ do: "result", outcome: "done" }]],
    fix: [saveFix(1), saveFix(2), saveFix(3)],
    review: [
      [
        { do: "dataPut", key: "review.feedback", content: "review feedback" },
        { do: "result", outcome: "changes_requested" },
      ],
      [
        { do: "dataPut", key: "review.notes", content: "notes" },
        { do: "result", outcome: "approved" },
      ],
      [
        { do: "dataPut", key: "review.notes", content: "notes" },
        { do: "result", outcome: "approved" },
      ],
    ],
  };
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: TICKET,
    inputs: { task: TASK, issue: "273", merge: "no" },
    repository: repo,
    executor: localExecutor({ ...process.env, PATH: `${bin}:${process.env.PATH}` }),
    adapters: fakeHarnessAdapters(script),
  });

  assert.equal(ended.result, "success");
  const prompt = (number: number) =>
    readFile(join(dirname(paths.workspace), `fix-${number}.md`), "utf8");
  assert.equal(
    await prompt(1),
    fixPrompt(
      1,
      "`test` ended with `failed`.\n\nThe test run failed. The end of its log:\n\ntest failure\n",
    ),
  );
  assert.equal(
    await prompt(2),
    fixPrompt(
      2,
      "`review` ended with `changes_requested`.\n\nThe review asked for these changes:\n\nreview feedback",
    ),
  );
  assert.equal(
    await prompt(3),
    fixPrompt(
      3,
      "`ship` ended with `ci_failed`.\n\nCI failed on the pull request:\n\nCI failure\nCI failure\n",
      "\n\n### Review 006-review\n\nreview feedback\n",
    ),
  );
});
