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
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
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

/** The `loopfile` under test, so a step's `loopfile data get` needs no global install. */
async function loopfileCommand(bin: string): Promise<void> {
  await executable(
    join(bin, "loopfile"),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`,
  );
}

/** A repository with one commit and a bare origin. */
async function gitRepo(repo: string, bare: string): Promise<void> {
  await mkdir(repo);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await writeFile(join(repo, "README.md"), "ticket test\n");
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: gitEnv });
  await run("git", ["init", "-q", "--bare", bare], { env: gitEnv });
  await run("git", ["remote", "add", "origin", bare], { cwd: repo, env: gitEnv });
  await run("git", ["push", "-q", "origin", "main"], { cwd: repo, env: gitEnv });
}

const done: FakeAction[] = [
  { do: "dataPut", key: "implement.criteria", content: "criterion 1: a.test.ts, it works" },
  { do: "result", outcome: "done" },
];

const describe: FakeAction[] = [
  { do: "dataPut", key: "describe.title", content: "feat: ticket title" },
  { do: "dataPut", key: "describe.body", content: "What changes for a user." },
  { do: "result", outcome: "done" },
];

const approve: FakeAction[] = [
  { do: "dataPut", key: "review.notes", content: "notes" },
  { do: "dataPut", key: "review.sha", content: "abc123" },
  { do: "result", outcome: "approved" },
];

/** A HOME per test, so ship's lock is not the real ~/.loopfile/ticket/ship.lock. */
function env(bin: string, home: string): NodeJS.ProcessEnv {
  return { ...process.env, ...gitEnv, HOME: home, PATH: `${bin}:${process.env.PATH}` };
}

function fixPrompt(number: number, max: number, why: string, handled = ""): string {
  return `You were implementing the GitHub issue below. The work is committed on the current
branch. A check of that work came back with problems. Fix those problems. Do not
start the issue again.

This is fix visit ${number} of at most ${max}.

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
5. Run \`npm run verify\` before you finish. Do not run \`npm run quality:mutation\`.
   The next step runs it.
6. Commit your fix to the current branch. Do not push and do not open a pull request.
7. Run \`loopfile result done\`. If you cannot go on without a person, run
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
  await mkdir(bin);
  await loopfileCommand(bin);
  await gitRepo(repo, bare);
  await executable(
    join(bin, "npm"),
    `if [ "$1" = ci ]; then exit 0; fi
if [ "$1" = run ] && [ "$2" = verify ]; then
  n=$(cat ${JSON.stringify(npmCount)} 2>/dev/null || printf 0)
  n=$((n + 1))
  printf %s "$n" > ${JSON.stringify(npmCount)}
  if [ "$n" -le 2 ]; then printf 'test failure\n'; exit 1; fi
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
    implement: [done],
    "fix-test": [saveFix(1)],
    "fix-review": [saveFix(2)],
    "fix-ci": [saveFix(3)],
    review: [
      [
        { do: "dataPut", key: "review.feedback", content: "review feedback" },
        { do: "result", outcome: "changes_requested" },
      ],
      approve,
      [{ do: "savePrompt", path: "../review-3.md" }, ...approve],
    ],
    describe: [describe, describe],
  };
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: TICKET,
    inputs: { task: TASK, issue: "273", merge: "no", ci: "yes" },
    repository: repo,
    executor: localExecutor(env(bin, home)),
    adapters: fakeHarnessAdapters(script),
  });

  assert.equal(ended.result, "success");
  const prompt = (number: number) =>
    readFile(join(dirname(paths.workspace), `fix-${number}.md`), "utf8");
  assert.equal(
    await prompt(1),
    fixPrompt(
      1,
      4,
      "`test` ended with `failed`.\n\nThe test run failed. The end of its log:\n\ntest failure\n",
    ),
  );
  assert.equal(
    await prompt(2),
    fixPrompt(
      1,
      3,
      "`review` ended with `changes_requested`.\n\nThe review asked for these changes:\n\nreview feedback",
    ),
  );
  assert.equal(
    await prompt(3),
    fixPrompt(
      1,
      3,
      "`ship` ended with `ci_failed`.\n\nCI failed on the pull request:\n\nCI failure\nCI failure\n",
      "\n\n### Review 006-review\n\nreview feedback\n",
    ),
  );
  // After a red CI, review sees its approval and reviews only the new commits.
  const review = await readFile(join(dirname(paths.workspace), "review-3.md"), "utf8");
  assert.match(review, /You approved commit `abc123` with these notes:\n\nnotes/);
  assert.match(review, /git show --remerge-diff/);
  assert.doesNotMatch(review, /git diff origin\/main\.\.\.HEAD/);
});

/**
 * With ci=no, ship does not wait for checks, so a repository with no CI ends ready
 * at once. The PR gets describe's title and description.
 */
test("the ticket Loopfile ships without CI when ci is no", async () => {
  const dir = join(root, "no-ci");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const runId = "20260921-120000-no-ci";
  const title = join(dir, "pr-title");
  const body = join(dir, "pr-body");
  await mkdir(bin, { recursive: true });
  await loopfileCommand(bin);
  await gitRepo(repo, join(dir, "origin.git"));
  await mkdir(join(repo, "scripts"));
  await executable(join(repo, "scripts", "check-pr-title.sh"), "exit 0\n");
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "title check"], { cwd: repo, env: gitEnv });
  await executable(join(bin, "npm"), "exit 0\n");
  await executable(
    join(bin, "gh"),
    `case "$1 $2" in
  "pr view") exit 1 ;;
  "pr create") printf %s "$4" > ${JSON.stringify(title)}; cat "$6" > ${JSON.stringify(body)} ;;
  "pr checks") printf 'no checks reported\n'; exit 1 ;;
esac
`,
  );
  const script: FakeScript = { implement: [done], review: [approve], describe: [describe] };
  await mkdir(runPaths(home, runId).root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: TICKET,
    inputs: { task: TASK, issue: "273", merge: "no", ci: "no" },
    repository: repo,
    executor: localExecutor(env(bin, home)),
    adapters: fakeHarnessAdapters(script),
  });

  assert.equal(ended.result, "success");
  assert.equal(await readFile(title, "utf8"), "feat: ticket title");
  assert.equal(
    await readFile(body, "utf8"),
    `What changes for a user.\n\nCloses #273\n\nMade by loopfile run ${runId}.\n`,
  );
});

/** main wants an up-to-date branch, so a merge refused as behind ships again. */
test("the ticket Loopfile ships again when the merge is behind main", async () => {
  const dir = join(root, "behind");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const runId = "20260921-120000-behind";
  const merges = join(dir, "merges");
  await mkdir(bin, { recursive: true });
  await loopfileCommand(bin);
  await gitRepo(repo, join(dir, "origin.git"));
  await executable(join(bin, "npm"), "exit 0\n");
  await executable(
    join(bin, "gh"),
    `case "$1 $2" in
  "pr view") [ "$4" = mergeStateStatus ] && printf 'BEHIND\\n' || exit 1 ;;
  "issue view") printf 'Ticket title\\n' ;;
  "pr merge") printf x >> ${JSON.stringify(merges)}; [ "$(cat ${JSON.stringify(merges)})" = xx ] ;;
esac
`,
  );
  const script: FakeScript = { implement: [done], review: [approve], describe: [describe] };
  await mkdir(runPaths(home, runId).root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: TICKET,
    inputs: { task: TASK, issue: "273", merge: "yes", ci: "no" },
    repository: repo,
    executor: localExecutor(env(bin, home)),
    adapters: fakeHarnessAdapters(script),
  });

  assert.equal(ended.result, "success");
  assert.equal(await readFile(merges, "utf8"), "xx");
});

/** test merges main first, so a conflict goes to resolve before review, then ships. */
test("the ticket Loopfile sends a conflict with main to resolve", async () => {
  const dir = join(root, "conflict");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const runId = "20260921-120000-conflict";
  const git = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await mkdir(bin, { recursive: true });
  await loopfileCommand(bin);
  await gitRepo(repo, join(dir, "origin.git"));
  // setup changes README on the run's branch and, as another run would, on main.
  await executable(
    join(bin, "npm"),
    `if [ "$1" = ci ]; then
  printf 'branch\\n' > README.md && git commit -qam branch
  cd ${JSON.stringify(repo)} && printf 'main\\n' > README.md && git commit -qam main && git push -q origin main
fi
exit 0
`,
  );
  // The fake agent cannot commit, so the next fetch commits the merge it resolved.
  await executable(
    join(bin, "git"),
    `if [ "$1" = fetch ] && ${JSON.stringify(git)} rev-parse -q --verify MERGE_HEAD > /dev/null; then
  ${JSON.stringify(git)} add -A && ${JSON.stringify(git)} commit -q --no-edit
fi
exec ${JSON.stringify(git)} "$@"
`,
  );
  await executable(
    join(bin, "gh"),
    `case "$1 $2" in
  "pr view") exit 1 ;;
  "issue view") printf 'Ticket title\\n' ;;
esac
`,
  );
  const script: FakeScript = {
    implement: [done],
    resolve: [
      [
        { do: "savePrompt", path: "../resolve-1.md" },
        { do: "write", path: "README.md", content: "resolved\n" },
        { do: "result", outcome: "done" },
      ],
    ],
    review: [approve],
    describe: [describe],
  };
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: TICKET,
    inputs: { task: TASK, issue: "273", merge: "no", ci: "no" },
    repository: repo,
    executor: localExecutor(env(bin, home)),
    adapters: fakeHarnessAdapters(script),
  });

  assert.equal(ended.result, "success");
  const prompt = await readFile(join(dirname(paths.workspace), "resolve-1.md"), "utf8");
  assert.match(prompt, /The merge is still in progress\.[\s\S]*CONFLICT[\s\S]*README\.md/);
});

/** A verify that passes on its second try is a flaky test, so the run goes on to review. */
test("the ticket Loopfile records a flaky test and does not send it to fix", async () => {
  const dir = join(root, "flake");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const runId = "20260921-120000-flake";
  const count = join(dir, "count");
  await mkdir(bin, { recursive: true });
  await loopfileCommand(bin);
  await gitRepo(repo, join(dir, "origin.git"));
  await executable(
    join(bin, "npm"),
    `if [ "$2" = verify ]; then
  n=$(cat ${JSON.stringify(count)} 2>/dev/null || printf 0)
  printf %s "$((n + 1))" > ${JSON.stringify(count)}
  if [ "$n" = 0 ]; then printf 'flaky failure\\n'; exit 1; fi
fi
exit 0
`,
  );
  await executable(
    join(bin, "gh"),
    `case "$1 $2" in
  "pr view") exit 1 ;;
  "issue view") printf 'Ticket title\\n' ;;
esac
`,
  );
  const script: FakeScript = { implement: [done], review: [approve], describe: [describe] };
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const ended = await executeRun({
    home,
    runId,
    source: TICKET,
    inputs: { task: TASK, issue: "273", merge: "no", ci: "no" },
    repository: repo,
    executor: localExecutor(env(bin, home)),
    adapters: fakeHarnessAdapters(script),
  });

  assert.equal(ended.result, "success");
  const events = await readFile(join(paths.root, "events.jsonl"), "utf8");
  assert.doesNotMatch(events, /"stepId":"fix-test"/);
  const flake = await readFile(join(paths.attempts, "003-test", "data", "test.flake"), "utf8");
  assert.match(flake, /flaky failure/);
});
