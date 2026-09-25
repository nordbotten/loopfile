import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256 } from "../application/data-store.ts";
import type { HarnessAdapters } from "../application/harness.ts";
import { parseEventLog, replay } from "../application/replay.ts";
import { endedHelp, runEndFromEvent } from "../application/run-end.ts";
import type { RunEvent } from "../domain/events.ts";
import type { WorkspaceMode } from "../domain/model.ts";
import { type EventLog, openEventLog } from "./event-log.ts";
import { type FakeScript, fakeHarnessAdapters } from "./fake-harness.test.ts";
import { groupAlive, localExecutor } from "./local-executor.ts";
import { pruneCommand } from "./prune-command.ts";
import { pathExists, runPaths } from "./run-directory.ts";
import { requestCancel, requestInterrupt } from "./run-owner.ts";
import {
  appendInternalError,
  type ExecuteRunOptions,
  executeRun,
  WorkflowRunError,
} from "./workflow-run.ts";

const run = promisify(execFile);
const gitEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env: gitEnv })).stdout.trim();
}

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-wfrun-")));
after(() => rm(root, { recursive: true, force: true }));
let count = 0;

/** A target repository with one commit, a Loopfile source and a home for the run. */
async function setup(manifest: string) {
  count += 1;
  const base = join(root, `case-${count}`);
  const repo = join(base, "repo");
  const source = join(base, "source");
  const home = join(base, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo, env: gitEnv });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo, env: gitEnv });
  await writeFile(join(source, "manifest.yaml"), manifest);
  const runId = "20260918-120000-aaaa";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  return { repo, source, home, runId };
}

async function execute(
  manifest: string,
  adapters?: HarnessAdapters,
  inputs?: ExecuteRunOptions["inputs"],
) {
  const { repo, source, home, runId } = await setup(manifest);
  const ended = await executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(),
    ...(adapters === undefined ? {} : { adapters }),
    ...(inputs === undefined ? {} : { inputs }),
  });
  const paths = runPaths(home, runId);
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  return { ended, events, paths, runId, repo };
}

async function executeFake(
  manifest: string,
  script: FakeScript,
  inputs?: ExecuteRunOptions["inputs"],
) {
  const adapters = fakeHarnessAdapters(script);
  return { ...(await execute(manifest, adapters, inputs)), calls: adapters.calls };
}

async function executeWithDelayedAttemptStarted(
  manifest: string,
  adapters: HarnessAdapters,
  delayMs: number,
) {
  const { repo, source, home, runId } = await setup(manifest);
  const paths = runPaths(home, runId);
  const log = await openEventLog(paths.events);
  const eventLog: EventLog = {
    async append(event) {
      if (event.type === "attempt.started") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return await log.append(event);
    },
    close: () => log.close(),
  };
  const ended = await executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(),
    adapters,
    eventLog,
  });
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  return { ended, events, paths, runId, repo };
}

const WORKSPACE_CASES = [
  { name: "isolate worktree", mode: "isolate" },
  { name: "isolate copy", mode: "isolate", target: "copy" },
  { name: "empty", mode: "empty" },
  { name: "here", mode: "here" },
] as const satisfies readonly {
  name: string;
  mode: WorkspaceMode;
  target?: "copy";
}[];

async function setupWorkspaceRun(
  manifest: string,
  workspaceCase: (typeof WORKSPACE_CASES)[number],
) {
  const run = await setup(manifest);
  let repository = run.repo;
  if ("target" in workspaceCase && workspaceCase.target === "copy") {
    repository = join(run.repo, "..", "plain-target");
    await mkdir(repository);
    await writeFile(join(repository, "README.md"), "copy source\n");
  }
  const paths = runPaths(run.home, run.runId);
  return {
    ...run,
    paths,
    repository,
    workspaceMode: workspaceCase.mode,
    workspace: workspaceCase.mode === "here" ? repository : paths.workspace,
  };
}

async function executeWorkspaceRun(
  manifest: string,
  workspaceCase: (typeof WORKSPACE_CASES)[number],
  options: Pick<ExecuteRunOptions, "cancelSignal" | "adapters" | "eventLog"> = {},
) {
  const run = await setupWorkspaceRun(manifest, workspaceCase);
  const ended = await executeRun({
    home: run.home,
    runId: run.runId,
    source: run.source,
    repository: run.repository,
    workspaceMode: run.workspaceMode,
    executor: localExecutor(),
    ...options,
  });
  return { ...run, ended };
}

const STRAIGHT = (test: string) => `formatVersion: 1
steps:
  - id: build
    kind: command
    run: echo built > out.txt
  - id: test
    kind: command
    run: ${test}
`;

test("a straight-line workflow runs every step in the workspace and ends in success", async () => {
  const { ended, events, paths } = await execute(
    STRAIGHT("grep -q built out.txt && pwd > cwd.txt"),
  );
  assert.equal(ended.result, "success");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.created",
      "owner.started",
      "attempt.started",
      "attempt.ended",
      "transition",
      "attempt.started",
      "attempt.ended",
      "transition",
      "run.ended",
    ],
  );
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "attempt.ended")
      .map((event) => event.type === "attempt.ended" && event.metrics),
    [
      {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        toolCalls: null,
        permissionDenials: null,
      },
      {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        toolCalls: null,
        permissionDenials: null,
      },
    ],
  );
  const transitions = events.filter((event) => event.type === "transition");
  assert.deepEqual(
    transitions.map((event) => [event.from, event.to, event.cause]),
    [
      ["build", "test", "next"],
      ["test", "$success", "next"],
    ],
  );
  assert.deepEqual(events.at(-1), {
    type: "run.ended",
    result: "success",
    reason: "end_state",
    metrics: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: null,
    },
    seq: 9,
    at: events.at(-1)?.at,
  });
  assert.equal((await readFile(join(paths.workspace, "cwd.txt"), "utf8")).trim(), paths.workspace);
});

test("run.created records the workspace and the attempts are numbered from 001", async () => {
  const { events, runId, paths } = await execute(STRAIGHT("exit 0"));
  const created = events.find((event) => event.type === "run.created");
  assert.deepEqual(
    created?.type === "run.created"
      ? {
          workspacePath: created.workspacePath,
          workspaceMode: created.workspaceMode,
          isolateKind: created.isolateKind,
          branch: created.branch,
        }
      : undefined,
    {
      workspacePath: paths.workspace,
      workspaceMode: "isolate",
      isolateKind: "worktree",
      branch: `loopfile/${runId}`,
    },
  );
  assert.match(created?.type === "run.created" ? (created.baseCommit ?? "") : "", /^[0-9a-f]{40}$/);
  const ids = events.flatMap((event) =>
    event.type === "attempt.started" ? [event.attemptId] : [],
  );
  assert.deepEqual(ids, ["001-build", "002-test"]);
});

test("a run launched from a worktree records its top level and HEAD", async () => {
  const { repo, source, home, runId } = await setup(CLEAN);
  const outerWorkspace = join(repo, "..", "outer-workspace");
  await git(repo, "worktree", "add", "-q", "-b", "outer", outerWorkspace);
  await writeFile(join(outerWorkspace, "outer.txt"), "outer\n");
  await git(outerWorkspace, "add", ".");
  await git(outerWorkspace, "commit", "-q", "-m", "outer");
  const outerHead = await git(outerWorkspace, "rev-parse", "HEAD");

  await executeRun({
    home,
    runId,
    source,
    repository: outerWorkspace,
    executor: localExecutor(),
  });

  const events = parseEventLog(await readFile(runPaths(home, runId).events, "utf8"));
  const created = events.find((event) => event.type === "run.created");
  assert.equal(created?.type === "run.created" && created.targetFolder, outerWorkspace);
  assert.equal(created?.type === "run.created" && Object.hasOwn(created, "repositoryPath"), false);
  assert.equal(created?.type === "run.created" && created.eventFormatVersion, 1);
  assert.equal(created?.type === "run.created" && created.baseCommit, outerHead);
});

const CLEAN = `formatVersion: 1
steps:
  - id: only
    kind: command
    run: exit 0
`;

test("a successful run removes its worktree and keeps the run branch", async () => {
  const { ended, paths, repo, runId } = await execute(CLEAN);
  assert.equal(ended.result, "success");
  assert.equal(ended.workspaceKept, undefined);
  await assert.rejects(stat(paths.workspace), { code: "ENOENT" });
  assert.doesNotMatch(await git(repo, "worktree", "list"), /workspace/);
  assert.equal(await git(repo, "branch", "--list", `loopfile/${runId}`), `loopfile/${runId}`);
});

test("a successful isolate run outside Git keeps its copy", async () => {
  const { ended, workspace, repository } = await executeWorkspaceRun(
    `formatVersion: 1
steps:
  - id: save
    kind: command
    run: echo saved > result.txt
`,
    WORKSPACE_CASES[1],
  );

  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "saved\n");
  assert.equal(await readFile(join(repository, "README.md"), "utf8"), "copy source\n");
});

test("a successful empty run keeps its folder", async () => {
  const { ended, workspace } = await executeWorkspaceRun(
    `formatVersion: 1
steps:
  - id: save
    kind: command
    run: echo saved > result.txt
`,
    WORKSPACE_CASES[2],
  );

  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "saved\n");
});

test("a successful here run leaves the user's folder unchanged", async () => {
  const { ended, paths, repo } = await executeWorkspaceRun(CLEAN, WORKSPACE_CASES[3]);

  assert.equal(ended.result, "success");
  await assert.rejects(stat(paths.workspace), { code: "ENOENT" });
  assert.equal(await readFile(join(repo, "README.md"), "utf8"), "hello\n");
  assert.equal(await git(repo, "status", "--porcelain"), "");
  assert.equal(await git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("a successful run with uncommitted work keeps its worktree and says why", async () => {
  const { ended, paths } = await execute(STRAIGHT("echo dirty > leftover.txt"));
  assert.equal(ended.result, "success");
  assert.match(ended.workspaceKept ?? "", new RegExp(`^workspace kept at ${paths.workspace}: `));
  assert.match(ended.workspaceKept ?? "", /leftover\.txt|untracked|modified/);
  assert.equal((await readFile(join(paths.workspace, "leftover.txt"), "utf8")).trim(), "dirty");
});

test("failed, cancelled and crashed runs keep workspaces in every mode", async (t) => {
  for (const workspaceCase of WORKSPACE_CASES) {
    await t.test(`${workspaceCase.name}: failed`, async () => {
      const { ended, workspace } = await executeWorkspaceRun(
        CLEAN.replace("exit 0", "echo retained > retained.txt && exit 3"),
        workspaceCase,
      );
      assert.equal(ended.result, "failure");
      assert.equal(await readFile(join(workspace, "retained.txt"), "utf8"), "retained\n");
    });

    await t.test(`${workspaceCase.name}: cancelled`, async () => {
      const { ended, workspace } = await executeWorkspaceRun(CLEAN, workspaceCase, {
        cancelSignal: AbortSignal.abort(),
      });
      assert.equal(ended.result, "cancelled");
      assert.equal((await stat(workspace)).isDirectory(), true);
    });

    await t.test(`${workspaceCase.name}: crashed`, async () => {
      const run = await setupWorkspaceRun(
        `formatVersion: 1
steps:
  - id: bug
    kind: agent
    harness: claude
    prompt: Work.
    on:
      done: $success
`,
        workspaceCase,
      );
      const paths = runPaths(run.home, run.runId);
      const underlying = await openEventLog(paths.events);
      const eventLog: EventLog = {
        append: async (event) => {
          if (event.type === "run.ended" && event.reason === "internal_error") {
            throw new Error("events unavailable");
          }
          return underlying.append(event);
        },
        close: () => underlying.close(),
      };
      const adapter = {
        prepare: () => {
          throw new Error("harness bug");
        },
      };

      await assert.rejects(
        executeRun({
          home: run.home,
          runId: run.runId,
          source: run.source,
          repository: run.repository,
          workspaceMode: run.workspaceMode,
          executor: localExecutor(),
          eventLog,
          adapters: { claude: adapter, pi: adapter } as unknown as HarnessAdapters,
        }),
        /harness bug/,
      );
      const events = parseEventLog(await readFile(paths.events, "utf8"));
      assert.equal(
        events.some((event) => event.type === "run.ended"),
        false,
      );
      assert.equal((await stat(run.workspace)).isDirectory(), true);
    });
  }
});

test("a retained workspace is removed when prune is requested", async () => {
  const { ended, home, paths, workspace } = await executeWorkspaceRun(CLEAN, WORKSPACE_CASES[2]);
  assert.equal(ended.result, "success");
  assert.equal((await stat(workspace)).isDirectory(), true);

  let report = "";
  const code = await pruneCommand(
    ["prune"],
    () => undefined,
    (text) => {
      report += text;
    },
    { LOOPFILE_HOME: home },
  );

  assert.equal(code, 0);
  assert.match(report, /removed: 1/);
  assert.equal(await pathExists(paths.root), false);
});

test("a failing step goes to onFailure and the run ends in failure", async () => {
  const { ended, events } = await execute(STRAIGHT("exit 3"));
  assert.equal(ended.result, "failure");
  const last = events.filter((event) => event.type === "transition").at(-1);
  assert.equal(last?.type === "transition" && last.to, "$failure");
  assert.equal(last?.type === "transition" && last.cause, "onFailure");
  assert.equal(last?.type === "transition" && last.reason, "nonzero_exit");
  const end = events.at(-1);
  assert.equal(end?.type === "run.ended" && end.result, "failure");
  assert.equal(events.filter((event) => event.type === "attempt.started").length, 2);
});

const OUTCOMES = (outcome: string) => `formatVersion: 1
steps:
  - id: test
    kind: command
    run: |
      node -e '
        const s = require("node:net").connect(process.env.LOOPFILE_ENDPOINT);
        s.write(JSON.stringify({
          attemptId: process.env.LOOPFILE_ATTEMPT_ID,
          secret: process.env.LOOPFILE_ATTEMPT_SECRET,
          argv: ["result", "${outcome}"],
        }) + "\\n");
        s.on("data", () => s.end());
      '
    on:
      passed: $success
      failed: $failure
`;

test("a reported outcome routes on it, both ways", async () => {
  const passed = await execute(OUTCOMES("passed"));
  assert.equal(passed.ended.result, "success");
  const failed = await execute(OUTCOMES("failed"));
  assert.equal(failed.ended.result, "failure");
  const transition = failed.events.find((event) => event.type === "transition");
  assert.equal(transition?.type === "transition" && transition.outcome, "failed");
  assert.equal(transition?.type === "transition" && transition.cause, "on");
  assert.ok(failed.events.some((event) => event.type === "outcome.reported"));
});

test("a step that never starts fails its attempt with start_failed", async () => {
  const { repo, source, home, runId } = await setup(STRAIGHT("exit 0"));
  const executor = { start: async () => ({ kind: "start-failed" as const, message: "no sh" }) };
  const ended = await executeRun({ home, runId, source, repository: repo, executor });
  assert.equal(ended.result, "failure");
  const events = parseEventLog(await readFile(runPaths(home, runId).events, "utf8"));
  const attempt = events.find((event) => event.type === "attempt.ended");
  assert.equal(attempt?.type === "attempt.ended" && attempt.reason, "start_failed");
});

test("a run owner bug ends the run with internal_error and updates status", async () => {
  const { repo, source, home, runId } = await setup(`formatVersion: 1
steps:
  - id: bug
    kind: agent
    harness: claude
    prompt: Work.
    on:
      done: $success
`);
  const adapter = {
    prepare: () => {
      throw new Error("harness bug");
    },
  };
  await assert.rejects(
    executeRun({
      home,
      runId,
      source,
      repository: repo,
      executor: localExecutor(),
      adapters: { claude: adapter, pi: adapter } as unknown as HarnessAdapters,
    }),
    /harness bug/,
  );
  const paths = runPaths(home, runId);
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  const end = events.at(-1);
  assert.equal(end?.type === "run.ended" && end.result, "failure");
  assert.equal(end?.type === "run.ended" && end.reason, "internal_error");
  const status = JSON.parse(await readFile(paths.status, "utf8"));
  assert.equal(status.state, "failed");
  assert.equal(status.endReason, "internal_error");
});

test("an internal error is not appended after a terminal event", async () => {
  let appends = 0;
  const log = {
    append: async () => {
      appends += 1;
      return {
        type: "run.ended" as const,
        result: "failure" as const,
        reason: "internal_error" as const,
        seq: 2,
        at: "2026-09-18T12:00:00.000Z",
      };
    },
    close: async () => undefined,
  };
  const terminalEvents = [
    {
      type: "run.ended",
      result: "success",
      reason: "end_state",
      seq: 1,
      at: "2026-09-18T12:00:00.000Z",
    },
    { type: "run.cancelled", seq: 1, at: "2026-09-18T12:00:00.000Z" },
  ] satisfies RunEvent[];

  for (const event of terminalEvents) await appendInternalError(log, [event]);
  assert.equal(appends, 0);
});

test("a Loopfile that does not load is refused", async () => {
  const { repo, source, home, runId } = await setup("formatVersion: 1\nsteps: []\n");
  await assert.rejects(
    executeRun({ home, runId, source, repository: repo, executor: localExecutor() }),
    WorkflowRunError,
  );
});

test("a run that already has events is not run again", async () => {
  const { repo, source, home, runId } = await setup(STRAIGHT("exit 0"));
  const options = { home, runId, source, repository: repo, executor: localExecutor() };
  await executeRun(options);
  await assert.rejects(executeRun(options), /already started/);
});

const FEEDBACK_LOOP = (
  tests = "run: grep -q fixed out.txt",
  extra = "",
  top = "",
) => `formatVersion: 1
${top}steps:
  - id: implement
    kind: agent
    harness: claude
    prompt: Implement.
    on:
      done: tests
  - id: tests
    kind: command
    ${tests}
  - id: review
    kind: agent
    harness: claude
    prompt: Review.
${extra}    outputs:
      feedback: [changes_requested]
    on:
      approved: $success
      changes_requested: implement
`;

const FIX: FakeScript["implement"][number] = [
  { do: "write", path: "out.txt", content: "fixed" },
  { do: "result", outcome: "done" },
];
const REVIEW_CHANGES = [
  { do: "dataPut", key: "review.feedback", content: "fix it" },
  { do: "result", outcome: "changes_requested" },
] as const;
const REVIEW_APPROVED = [{ do: "result", outcome: "approved" }] as const;

const attemptSteps = (events: ReturnType<typeof parseEventLog>) =>
  events.flatMap((event) => (event.type === "attempt.started" ? [event.stepId] : []));
const runEnd = (events: ReturnType<typeof parseEventLog>) => events.at(-1);

test("implement, tests, review cycles until the review approves, and replay shows the path", async () => {
  const script: FakeScript = {
    implement: [FIX, FIX],
    review: [[...REVIEW_CHANGES], [...REVIEW_APPROVED]],
  };
  const { ended, events } = await execute(FEEDBACK_LOOP(), fakeHarnessAdapters(script));
  assert.equal(ended.result, "success");
  const path = ["implement", "tests", "review", "implement", "tests", "review"];
  assert.deepEqual(attemptSteps(events), path);
  const state = replay(events);
  assert.deepEqual(
    state.transitions.map((t) => [t.from, t.to, t.cause]),
    [
      ["implement", "tests", "on"],
      ["tests", "review", "next"],
      ["review", "implement", "on"],
      ["implement", "tests", "on"],
      ["tests", "review", "next"],
      ["review", "$success", "on"],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(state.attempts).map(([id, list]) => [id, list.length])),
    { implement: 2, tests: 2, review: 2 },
  );
  assert.deepEqual(runEnd(events), { ...runEnd(events), type: "run.ended", reason: "end_state" });
});

test("a failing tests step with no onFailure ends the run in failure", async () => {
  const script: FakeScript = { implement: [[{ do: "result", outcome: "done" }]] };
  const { ended, events } = await execute(FEEDBACK_LOOP(), fakeHarnessAdapters(script));
  assert.equal(ended.result, "failure");
  const end = runEnd(events);
  assert.equal(end?.type === "run.ended" && end.result, "failure");
  assert.equal(end?.type === "run.ended" && end.reason, "end_state");
  assert.deepEqual(attemptSteps(events), ["implement", "tests"]);
});

test("status metrics sum reports from two agent-step calls", async () => {
  const { ended, events, paths } = await execute(
    `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    prompt: Work.
    on:
      again: work
      done: $success
`,
    fakeHarnessAdapters({
      work: [
        [
          {
            do: "activity",
            activity: {
              kind: "metrics",
              metrics: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
                costUsd: 1,
                toolCalls: 4,
                permissionDenials: null,
              },
            },
          },
          { do: "result", outcome: "again" },
        ],
        [
          {
            do: "activity",
            activity: {
              kind: "metrics",
              metrics: {
                inputTokens: 10,
                outputTokens: 20,
                totalTokens: 30,
                costUsd: 2,
                toolCalls: 40,
                permissionDenials: null,
              },
            },
          },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.deepEqual(
    events
      .filter((event) => event.type === "attempt.ended")
      .map((event) => event.type === "attempt.ended" && event.metrics),
    [
      {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        costUsd: 1,
        toolCalls: 4,
        permissionDenials: null,
      },
      {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        costUsd: 2,
        toolCalls: 40,
        permissionDenials: null,
      },
    ],
  );
  assert.deepEqual(JSON.parse(await readFile(paths.status, "utf8")).metrics, {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    costUsd: 3,
    toolCalls: 44,
    permissionDenials: null,
  });
});

test("status metrics sum all three Ralph iterations", async () => {
  const { ended, events, paths } = await execute(
    `formatVersion: 1
steps:
  - id: loop
    kind: ralph
    harness: claude
    maxIterations: 3
    prompt: Loop.
    on:
      done: $success
`,
    fakeHarnessAdapters({
      loop: [
        [
          {
            do: "activity",
            activity: {
              kind: "metrics",
              metrics: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
                costUsd: 1,
                toolCalls: 4,
                permissionDenials: null,
              },
            },
          },
        ],
        [
          {
            do: "activity",
            activity: {
              kind: "metrics",
              metrics: {
                inputTokens: 10,
                outputTokens: 20,
                totalTokens: 30,
                costUsd: 2,
                toolCalls: 40,
                permissionDenials: null,
              },
            },
          },
        ],
        [
          {
            do: "activity",
            activity: {
              kind: "metrics",
              metrics: {
                inputTokens: 100,
                outputTokens: 200,
                totalTokens: 300,
                costUsd: 4,
                toolCalls: 400,
                permissionDenials: null,
              },
            },
          },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  const attempt = events.find((event) => event.type === "attempt.ended");
  assert.deepEqual(attempt?.type === "attempt.ended" && attempt.metrics, {
    inputTokens: 111,
    outputTokens: 222,
    totalTokens: 333,
    costUsd: 7,
    toolCalls: 444,
    permissionDenials: null,
  });
  assert.deepEqual(JSON.parse(await readFile(paths.status, "utf8")).metrics, {
    inputTokens: 111,
    outputTokens: 222,
    totalTokens: 333,
    costUsd: 7,
    toolCalls: 444,
    permissionDenials: null,
  });
});

test("denials from a completed attempt do not hint for a later failed attempt", async () => {
  const script: FakeScript = {
    implement: [
      [
        {
          do: "activity",
          activity: {
            kind: "metrics",
            metrics: {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              costUsd: null,
              toolCalls: null,
              permissionDenials: 38,
            },
          },
        },
        { do: "result", outcome: "done" },
      ],
    ],
  };
  const { events, paths, runId } = await execute(FEEDBACK_LOOP(), fakeHarnessAdapters(script));
  const end = runEnd(events);
  assert.equal(end?.type, "run.ended");
  if (end?.type !== "run.ended") return;
  assert.equal(end.metrics?.permissionDenials, null);
  assert.equal(JSON.parse(await readFile(paths.status, "utf8")).metrics.permissionDenials, null);
  assert.doesNotMatch(endedHelp(runEndFromEvent(runId, end)), /tool calls were denied/);
});

test("a review that never approves ends the run with attempt_limit and starts no third review", async () => {
  const script: FakeScript = {
    implement: [FIX, FIX, FIX],
    review: [[...REVIEW_CHANGES], [...REVIEW_CHANGES], [...REVIEW_CHANGES]],
  };
  const { ended, events } = await execute(
    FEEDBACK_LOOP("run: grep -q fixed out.txt", "    maxAttempts: 2\n"),
    fakeHarnessAdapters(script),
  );
  assert.equal(ended.result, "failure");
  const end = runEnd(events);
  assert.equal(end?.type === "run.ended" && end.reason, "attempt_limit");
  assert.equal(end?.type === "run.ended" && end.stepId, "review");
  assert.equal(attemptSteps(events).filter((id) => id === "review").length, 2);
  const last = events.filter((event) => event.type === "transition").at(-1);
  assert.equal(last?.type === "transition" && last.to, "review", "the move is on the record");
});

test("maxTransitions ends the run with transition_limit and no extra transition", async () => {
  const script: FakeScript = {
    implement: [FIX, FIX],
    review: [[...REVIEW_CHANGES], [...REVIEW_CHANGES]],
  };
  const { events } = await execute(
    FEEDBACK_LOOP("run: grep -q fixed out.txt", "", "maxTransitions: 3\n"),
    fakeHarnessAdapters(script),
  );
  assert.equal(events.filter((event) => event.type === "transition").length, 3);
  const end = runEnd(events);
  assert.equal(end?.type === "run.ended" && end.reason, "transition_limit");
  assert.equal(end?.type === "run.ended" && end.result, "failure");
});

test("changes_requested with no feedback put fails the attempt with missing_output", async () => {
  const script: FakeScript = {
    implement: [FIX],
    review: [[{ do: "result", outcome: "changes_requested" }]],
  };
  const { events } = await execute(FEEDBACK_LOOP(), fakeHarnessAdapters(script));
  const reviewEnd = events.find(
    (event) => event.type === "attempt.ended" && event.attemptId === "003-review",
  );
  assert.equal(reviewEnd?.type === "attempt.ended" && reviewEnd.reason, "missing_output");
  assert.equal(reviewEnd?.type === "attempt.ended" && reviewEnd.output, "feedback");
  assert.equal(reviewEnd?.type === "attempt.ended" && reviewEnd.result, "failure");
});

const SLEEPY_AGENT = (extra: string, top = "", timeout = "1s") => `formatVersion: 1
${top}steps:
  - id: work
    kind: agent
    harness: claude
    prompt: Work.
    timeout: ${timeout}
${extra}    on:
      done: $success
    onFailure: $failure
`;

test("an agent step that outlives its timeout ends with timeout and takes onFailure", async () => {
  const script: FakeScript = {
    work: [
      [
        { do: "sleep", ms: 5000 },
        { do: "result", outcome: "done" },
      ],
    ],
  };
  const started = Date.now();
  const { ended, events } = await execute(SLEEPY_AGENT(""), fakeHarnessAdapters(script));
  assert.ok(Date.now() - started < 4500, "the process was cancelled, not waited for");
  assert.equal(ended.result, "failure");
  const transition = events.find((event) => event.type === "transition");
  assert.equal(transition?.type === "transition" && transition.reason, "timeout");
  assert.equal(transition?.type === "transition" && transition.cause, "onFailure");
  assert.equal(transition?.type === "transition" && transition.to, "$failure");
});

test("a command step that outlives its timeout does the same", async () => {
  const { ended, events } = await execute(`formatVersion: 1
steps:
  - id: slow
    kind: command
    run: sleep 5
    timeout: 1s
`);
  assert.equal(ended.result, "failure");
  const end = events.find((event) => event.type === "attempt.ended");
  assert.equal(end?.type === "attempt.ended" && end.reason, "timeout");
  const transition = events.find((event) => event.type === "transition");
  assert.equal(transition?.type === "transition" && transition.cause, "onFailure");
});

test("runTimeout interrupts the running attempt and ends the run, with no process left", async () => {
  const marker = join(root, "run-timeout-pid");
  const started = Date.now();
  const { ended, events } = await execute(`formatVersion: 1
runTimeout: 1s
steps:
  - id: slow
    kind: command
    run: |
      echo $$ > ${marker}
      sleep 5
`);
  assert.ok(Date.now() - started < 3000, "the run did not wait for the step");
  assert.equal(ended.result, "failure");
  assert.deepEqual(
    events.slice(2).map((event) => event.type),
    ["attempt.started", "attempt.interrupted", "run.ended"],
  );
  const end = runEnd(events);
  assert.equal(end?.type === "run.ended" && end.reason, "run_timeout");
  const interrupted = events.find((event) => event.type === "attempt.interrupted");
  assert.equal(interrupted?.type === "attempt.interrupted" && "metrics" in interrupted, false);
  const pid = Number((await readFile(marker, "utf8")).trim());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

const RALPH_PREFIX = join(root, "ralph-stale");

/** Iteration 1 keeps its secret. Iteration 2 tries it, records the refusal, then reports done. */
const RALPH_CHILD = `
const net = require("node:net");
const fs = require("node:fs");
const [iteration, prefix] = process.argv.slice(1);
const call = (secret, argv) => new Promise((resolve) => {
  const socket = net.connect(process.env.LOOPFILE_ENDPOINT);
  socket.write(JSON.stringify({
    attemptId: process.env.LOOPFILE_ATTEMPT_ID,
    secret,
    iteration: Number(process.env.LOOPFILE_ITERATION),
    argv,
  }) + "\\n");
  socket.on("data", (data) => { socket.end(); resolve(data.toString().split("\\n")[0]); });
});
(async () => {
  if (iteration === "1") return fs.writeFileSync(prefix + ".secret", process.env.LOOPFILE_ATTEMPT_SECRET);
  const old = fs.readFileSync(prefix + ".secret", "utf8");
  fs.writeFileSync(prefix + ".json", await call(old, ["result", "done"]));
  await call(process.env.LOOPFILE_ATTEMPT_SECRET, ["result", "done"]);
})();
`;

test("a Ralph step runs to success on its second iteration, and the first secret is stale", async () => {
  const adapter = {
    prepare: (call: { context: { attemptSecret: string; iteration?: number } }) => ({
      command: process.execPath,
      args: ["-e", RALPH_CHILD, String(call.context.iteration), RALPH_PREFIX],
      wiringFiles: {},
      parseStdoutLine: () => [],
    }),
  };
  const adapters = { claude: adapter, pi: adapter } as unknown as HarnessAdapters;
  const { ended, events } = await execute(
    `formatVersion: 1
steps:
  - id: loop
    kind: ralph
    harness: claude
    prompt: Loop.
    on:
      done: $success
`,
    adapters,
  );
  assert.equal(ended.result, "success");
  const reply = JSON.parse(await readFile(`${RALPH_PREFIX}.json`, "utf8"));
  assert.equal(reply.code, "stale_attempt");
  assert.equal(events.filter((event) => event.type === "iteration.started").length, 2);
  const outcome = events.find((event) => event.type === "outcome.reported");
  assert.equal(outcome?.type === "outcome.reported" && outcome.iteration, 2);
});

test("a run started from a Ralph step does not leak LOOPFILE_ITERATION to its inner run", async () => {
  const outer = `formatVersion: 1
steps:
  - id: launch
    kind: ralph
    harness: claude
    prompt: Launch an inner run.
    maxIterations: 1
    on:
      done: $success
`;
  const { repo, source, home, runId } = await setup(outer);
  const innerSource = join(source, "inner");
  const marker = join(home, "inner-run-id");
  await mkdir(innerSource);
  await writeFile(
    join(innerSource, "manifest.yaml"),
    `formatVersion: 1
steps:
  - id: check
    kind: command
    run: printf '%s\\n' "\${LOOPFILE_ITERATION-unset}"
`,
  );
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const adapter = {
    prepare: () => ({
      command: process.execPath,
      args: [
        "-e",
        `const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const env = { ...process.env };
delete env.LOOPFILE_ENDPOINT;
const inner = spawnSync(process.execPath, [process.argv[1], process.argv[2]], {
  cwd: process.argv[3], env, encoding: "utf8"
});
if (inner.status !== 0) process.exit(inner.status ?? 1);
writeFileSync(process.argv[4], inner.stdout.trim().split("\\n")[0]);
const result = spawnSync(process.execPath, [process.argv[1], "result", "done"], {
  stdio: "inherit"
});
process.exit(result.status ?? 1);`,
        cli,
        innerSource,
        repo,
        marker,
      ],
      wiringFiles: {},
      parseStdoutLine: () => [],
    }),
  };
  const ended = await executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor({ ...process.env, LOOPFILE_HOME: home }),
    adapters: { claude: adapter, pi: adapter } as unknown as HarnessAdapters,
  });
  assert.equal(ended.result, "success");
  const innerRunId = await readFile(marker, "utf8");
  assert.equal(
    await readFile(join(runPaths(home, innerRunId).attempts, "001-check", "stdout"), "utf8"),
    "unset\n",
  );
});

test("status.json shows the final state and activity.log holds the activity, not the secret", async () => {
  const secretFile = join(root, "activity-secret");
  const child = `
    const secret = process.env.LOOPFILE_ATTEMPT_SECRET;
    require("node:fs").writeFileSync(process.argv[1], secret);
    console.log(JSON.stringify({ kind: "tool", tool: "Read", target: "a.ts" }));
    console.log(JSON.stringify({ kind: "progress", text: "thinking hard " + secret }));
    require("node:child_process").spawnSync(process.execPath, [process.argv[2], "result", "done"], { stdio: "inherit" });
  `;
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  const adapter = {
    prepare: () => ({
      command: process.execPath,
      args: ["-e", child, secretFile, cli],
      wiringFiles: {},
      parseStdoutLine: (line: string) => [JSON.parse(line)],
    }),
  };
  const adapters = { claude: adapter, pi: adapter } as unknown as HarnessAdapters;
  const { ended, paths } = await execute(SLEEPY_AGENT("", "", "5s"), adapters);
  assert.equal(ended.result, "success");
  const status = JSON.parse(await readFile(paths.status, "utf8"));
  assert.equal(status.state, "completed");
  const log = await readFile(paths.activity, "utf8");
  assert.match(log, /thinking hard/);
  assert.match(log, /Read/);
  assert.doesNotMatch(log, new RegExp((await readFile(secretFile, "utf8")).trim()));
});

test("Handlebars fills handoffs without escaping, keeps an empty dotted key empty, and unescapes \\{{", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: review
    kind: agent
    harness: claude
    prompt: Review.
    outputs:
      feedback: [done]
    on:
      done: test
  - id: test
    kind: agent
    harness: claude
    prompt: Test.
    outputs:
      log: [unused]
    on:
      done: implement
      unused: $failure
  - id: implement
    kind: agent
    harness: claude
    prompt: |
      handoff: {{ review.feedback }}
      missing: [{{ test.log }}]
      literal: \\{{
    on:
      done: $success
`;
  const handoff = "<>&\"'";
  const script: FakeScript = {
    review: [
      [
        { do: "savePrompt", path: "../review.md" },
        { do: "dataPut", key: "review.feedback", content: handoff },
        { do: "result", outcome: "done" },
      ],
    ],
    test: [
      [
        { do: "savePrompt", path: "../test.md" },
        { do: "result", outcome: "done" },
      ],
    ],
    implement: [
      [
        { do: "savePrompt", path: "../implement.md" },
        { do: "result", outcome: "done" },
      ],
    ],
  };
  const { ended, events, paths } = await execute(manifest, fakeHarnessAdapters(script));
  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(paths.workspace, "..", "review.md"), "utf8"), "Review.");
  assert.equal(await readFile(join(paths.workspace, "..", "test.md"), "utf8"), "Test.");
  const prompt = await readFile(join(paths.workspace, "..", "implement.md"), "utf8");
  assert.equal(prompt, `handoff: ${handoff}\nmissing: []\nliteral: {{\n`);
  const [fill] = events.filter((event) => event.type === "prompt.filled");
  assert.equal(fill?.attemptId, "003-implement");
  assert.equal(fill?.stepId, "implement");
  assert.deepEqual(fill?.keys, { "review.feedback": true, "test.log": false });
  assert.equal(fill?.size, Buffer.byteLength(prompt, "utf8"));
  assert.equal(fill?.digest, sha256(Buffer.from(prompt, "utf8")));
});

test("a prompt's {{#if review.feedback}} is empty on the first visit and filled on the next", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: implement
    kind: agent
    harness: claude
    prompt: "Fix: [{{#if review.feedback}}{{ review.feedback }}{{/if}}]"
    on:
      done: review
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
  const script: FakeScript = {
    implement: [
      [
        { do: "savePrompt", path: "p1.txt" },
        { do: "result", outcome: "done" },
      ],
      [
        { do: "savePrompt", path: "p2.txt" },
        { do: "result", outcome: "done" },
      ],
    ],
    review: [[...REVIEW_CHANGES], [...REVIEW_APPROVED]],
  };
  const { ended, events, paths } = await execute(manifest, fakeHarnessAdapters(script));
  assert.equal(ended.result, "success");
  const first = await readFile(join(paths.workspace, "p1.txt"), "utf8");
  const second = await readFile(join(paths.workspace, "p2.txt"), "utf8");
  assert.equal(first, "Fix: []");
  assert.equal(second, "Fix: [fix it]");
  const fills = events.flatMap((event) => (event.type === "prompt.filled" ? [event] : []));
  assert.deepEqual(
    fills.map((fill) => [fill.attemptId, fill.stepId, fill.keys, fill.digest]),
    [
      ["001-implement", "implement", { "review.feedback": false }, sha256(Buffer.from(first))],
      ["003-implement", "implement", { "review.feedback": true }, sha256(Buffer.from(second))],
    ],
  );
  const fill = events.findIndex((event) => event.type === "prompt.filled");
  assert.equal(events[fill + 1]?.type, "attempt.started");
  assert.equal(replay(events).attempts.implement?.length, 2);
});

test("a prompt reads each visit and its declared limits from $run.attempt", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    maxAttempts: 3
    timeout: 30s
    prompt: "{{ $run.attempt.id }}|{{ $run.attempt.startedAt }}|{{ $run.attempt.number }}|{{ $run.attempt.maxAttempts }}|{{ $run.attempt.timeout }}|{{ $run.attempt.lastAttempt }}"
    on:
      again: work
      done: $success
`;
  const script: FakeScript = {
    work: [
      [
        { do: "savePrompt", path: "one.txt" },
        { do: "result", outcome: "again" },
      ],
      [
        { do: "savePrompt", path: "two.txt" },
        { do: "result", outcome: "again" },
      ],
      [
        { do: "savePrompt", path: "three.txt" },
        { do: "result", outcome: "done" },
      ],
    ],
  };
  const { ended, events, paths } = await execute(manifest, fakeHarnessAdapters(script));
  assert.equal(ended.result, "success");
  const prompts = await Promise.all(
    ["one.txt", "two.txt", "three.txt"].map((file) =>
      readFile(join(paths.workspace, file), "utf8"),
    ),
  );
  assert.deepEqual(
    prompts.map((prompt) => {
      const [id, startedAt, number, maxAttempts, timeout, lastAttempt] = prompt.split("|");
      assert.ok(startedAt);
      return [id, number, maxAttempts, timeout, lastAttempt];
    }),
    [
      ["001-work", "1", "3", "30s", "false"],
      ["002-work", "2", "3", "30s", "false"],
      ["003-work", "3", "3", "30s", "true"],
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "prompt.filled").map((event) => event.reads),
    [
      {
        run: [
          "$run.attempt.id",
          "$run.attempt.startedAt",
          "$run.attempt.number",
          "$run.attempt.maxAttempts",
          "$run.attempt.timeout",
          "$run.attempt.lastAttempt",
        ],
      },
      {
        run: [
          "$run.attempt.id",
          "$run.attempt.startedAt",
          "$run.attempt.number",
          "$run.attempt.maxAttempts",
          "$run.attempt.timeout",
          "$run.attempt.lastAttempt",
        ],
      },
      {
        run: [
          "$run.attempt.id",
          "$run.attempt.startedAt",
          "$run.attempt.number",
          "$run.attempt.maxAttempts",
          "$run.attempt.timeout",
          "$run.attempt.lastAttempt",
        ],
      },
    ],
  );
});

test("a prompt reads run facts, limits and earlier attempts", async () => {
  const manifest = `formatVersion: 1
maxTransitions: 4
runTimeout: 1h
steps:
  - id: work
    kind: agent
    harness: claude
    maxAttempts: 4
    prompt: "{{ $run.runId }}|{{ $run.loopfileName }}|{{ $run.startedAt }}|{{ $run.targetFolder }}|{{ $run.branch }}|{{ $run.baseCommit }}|{{ $run.transitions }}|{{ $run.maxTransitions }}|{{ $run.runTimeout }}{{#each $run.attempts }}\\n{{ stepId }}|{{ attemptId }}|{{ number }}|{{ result }}|{{ reason }}|{{ outcome }}|{{ message }}|{{ startedAt }}|{{ index }}|{{ newest }}{{/each}}"
    on:
      again: work
      done: $success
`;
  const { ended, events, paths, runId } = await execute(
    manifest,
    fakeHarnessAdapters({
      work: [
        [
          { do: "savePrompt", path: "one.txt" },
          { do: "result", outcome: "again", message: "one" },
        ],
        [
          { do: "savePrompt", path: "two.txt" },
          { do: "result", outcome: "again", message: "two" },
        ],
        [
          { do: "savePrompt", path: "three.txt" },
          { do: "result", outcome: "again", message: "three" },
        ],
        [
          { do: "savePrompt", path: "four.txt" },
          { do: "result", outcome: "done", message: "four" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  const created = events.find((event) => event.type === "run.created");
  assert.equal(created?.type, "run.created");
  if (created?.type !== "run.created") return;
  const started = events.filter(
    (event): event is Extract<RunEvent, { type: "attempt.started" }> =>
      event.type === "attempt.started",
  );
  const prompts = await Promise.all(
    ["one.txt", "two.txt", "three.txt", "four.txt"].map((file) =>
      readFile(join(paths.workspace, file), "utf8"),
    ),
  );
  assert.deepEqual(
    prompts,
    [0, 1, 2, 3].map((transitions, current) => {
      const attempts = started.slice(0, current);
      return [
        `${runId}|source|${created.at}|${created.targetFolder}|${created.branch}|${created.baseCommit}|${transitions}|4|1h`,
        ...attempts.map(
          (attempt, index) =>
            `work|${attempt.attemptId}|${index + 1}|success|outcome|again|${["one", "two", "three"][index]}|${attempt.at}|${index + 1}|${index === attempts.length - 1}`,
        ),
      ].join("\n");
    }),
  );
});

test("a Ralph prompt reads its iteration and the attempt that sent it here", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: seed
    kind: agent
    harness: claude
    prompt: seed
    on:
      sent: loop
  - id: loop
    kind: ralph
    harness: claude
    maxIterations: 3
    prompt: "{{ $run.attempt.iteration }}|{{ $run.attempt.maxIterations }}|{{ $run.attempt.lastIteration }}|{{#if $run.attempt.previousIteration}}{{ $run.attempt.previousIteration.number }}|{{ $run.attempt.previousIteration.reason }}{{else}}none{{/if}}|{{ $run.previous.stepId }}|{{ $run.previous.attemptId }}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      seed: [[{ do: "result", outcome: "sent" }]],
      loop: [
        [{ do: "savePrompt", path: "one.txt" }],
        [
          { do: "savePrompt", path: "two.txt" },
          { do: "exit", code: 1 },
        ],
        [
          { do: "savePrompt", path: "three.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.deepEqual(
    await Promise.all(
      ["one.txt", "two.txt", "three.txt"].map((file) =>
        readFile(join(paths.workspace, file), "utf8"),
      ),
    ),
    [
      "1|3|false|none|seed|001-seed",
      "2|3|false|1|no_outcome|seed|001-seed",
      "3|3|true|2|nonzero_exit|seed|001-seed",
    ],
  );
});

test("an agent prompt has one iteration", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    prompt: "{{ $run.attempt.iteration }}|{{ $run.attempt.maxIterations }}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      work: [
        [
          { do: "savePrompt", path: "prompt.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(paths.workspace, "prompt.txt"), "utf8"), "1|1");
});

test("a prompt reads the outcome and handoff from the attempt that sent it here", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: review
    kind: agent
    harness: claude
    prompt: review
    outputs: [feedback]
    on:
      changes_requested: fix
  - id: fix
    kind: agent
    harness: claude
    prompt: "{{ $run.previous.stepId }}|{{ $run.previous.attemptId }}|{{ $run.previous.outcome }}|{{ $run.previous.message }}|{{ $run.previous.reason }}|{{ $run.previous.data.review.feedback }}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      review: [
        [
          { do: "dataPut", key: "review.feedback", content: "change the tests" },
          { do: "result", outcome: "changes_requested", message: "needs a fix" },
        ],
      ],
      fix: [
        [
          { do: "savePrompt", path: "previous.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.equal(
    await readFile(join(paths.workspace, "previous.txt"), "utf8"),
    "review|001-review|changes_requested|needs a fix||change the tests",
  );
});

test("a timeout leaves the prior outcome and message empty", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    timeout: 0.01s
    prompt: work
    on:
      done: $failure
    onFailure: fix
  - id: fix
    kind: agent
    harness: claude
    prompt: "{{ $run.previous.stepId }}|{{ $run.previous.attemptId }}|{{ $run.previous.outcome }}|{{ $run.previous.message }}|{{ $run.previous.reason }}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      work: [[{ do: "sleep", ms: 100 }]],
      fix: [
        [
          { do: "savePrompt", path: "timeout.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.equal(
    await readFile(join(paths.workspace, "timeout.txt"), "utf8"),
    "work|001-work|||timeout",
  );
});

test("a data put at process start is accepted before attempt.started is appended", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: review
    kind: agent
    harness: claude
    prompt: review
    outputs: [feedback]
    on:
      done: next
  - id: next
    kind: agent
    harness: claude
    prompt: "{{ $run.previous.data.review.feedback }}"
    on:
      done: $success
`;
  const { ended, paths } = await executeWithDelayedAttemptStarted(
    manifest,
    fakeHarnessAdapters({
      review: [
        [
          { do: "dataPut", key: "review.feedback", content: "early handoff" },
          { do: "result", outcome: "done" },
        ],
      ],
      next: [
        [
          { do: "savePrompt", path: "handoff.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
    500,
  );
  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(paths.workspace, "handoff.txt"), "utf8"), "early handoff");
});

test("a result at process start is accepted before attempt.started is appended", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    prompt: work
    on:
      done: $success
`;
  const { ended, events } = await executeWithDelayedAttemptStarted(
    manifest,
    fakeHarnessAdapters({ work: [[{ do: "result", outcome: "done" }]] }),
    500,
  );
  assert.equal(ended.result, "success");
  assert.ok(
    events.findIndex((event) => event.type === "attempt.started") <
      events.findIndex((event) => event.type === "outcome.reported"),
  );
});

test("a prompt follows its latest incoming transition instead of the latest outcome", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: review
    kind: agent
    harness: claude
    prompt: review
    outputs: [feedback]
    on:
      done: test
  - id: test
    kind: agent
    harness: claude
    prompt: test
    outputs: [log]
    on:
      done: $failure
    onFailure: fix
  - id: fix
    kind: agent
    harness: claude
    prompt: "{{ $run.previous.stepId }}|{{ $run.previous.data.review.feedback }}|{{ $run.previous.data.test.log }}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      review: [
        [
          { do: "dataPut", key: "review.feedback", content: "review handoff" },
          { do: "result", outcome: "done" },
        ],
      ],
      test: [
        [
          { do: "dataPut", key: "test.log", content: "test handoff" },
          { do: "exit", code: 1 },
        ],
      ],
      fix: [
        [
          { do: "savePrompt", path: "transition.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.equal(
    await readFile(join(paths.workspace, "transition.txt"), "utf8"),
    "test||test handoff",
  );
});

test("a first step sees no prior attempt", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: first
    kind: agent
    harness: claude
    prompt: "{{#if $run.previous}}prior{{else}}first{{/if}}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      first: [
        [
          { do: "savePrompt", path: "first.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(paths.workspace, "first.txt"), "utf8"), "first");
});

test("a prompt shows empty values for unset limits", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    prompt: "{{ $run.attempt.maxAttempts }}|{{ $run.attempt.timeout }}|{{ $run.maxTransitions }}|{{ $run.runTimeout }}"
    on:
      done: $success
`;
  const { ended, paths } = await execute(
    manifest,
    fakeHarnessAdapters({
      work: [
        [
          { do: "savePrompt", path: "attempt.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  );
  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(paths.workspace, "attempt.txt"), "utf8"), "|||");
});

test("an input history entry has its index and newest flag", async () => {
  const manifest = `formatVersion: 1
inputs:
  topic: input text
steps:
  - id: work
    kind: agent
    harness: claude
    prompt: "{{#each $history.input.topic}}[{{ value }}|{{ index }}|{{ newest }}]{{/each}}"
    on:
      done: $success
`;
  const { repo, source, home, runId } = await setup(manifest);
  const ended = await executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(),
    inputs: { topic: "input-value" },
    adapters: fakeHarnessAdapters({
      work: [
        [
          { do: "savePrompt", path: "input.txt" },
          { do: "result", outcome: "done" },
        ],
      ],
    }),
  });
  assert.equal(ended.result, "success");
  assert.equal(
    await readFile(join(runPaths(home, runId).workspace, "input.txt"), "utf8"),
    "[input-value|1|true]",
  );
});

test("a review loop marks only feedback since the prior implement attempt as new", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: implement
    kind: agent
    harness: claude
    prompt: "{{#each $history.review.feedback}}[{{ value }}|{{ new }}]{{/each}}"
    on:
      done: review
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
  const script: FakeScript = {
    implement: [
      [
        { do: "savePrompt", path: "first.txt" },
        { do: "result", outcome: "done" },
      ],
      [
        { do: "savePrompt", path: "second.txt" },
        { do: "result", outcome: "done" },
      ],
      [
        { do: "savePrompt", path: "third.txt" },
        { do: "result", outcome: "done" },
      ],
    ],
    review: [
      [
        { do: "dataPut", key: "review.feedback", content: "first" },
        { do: "result", outcome: "changes_requested" },
      ],
      [
        { do: "dataPut", key: "review.feedback", content: "second" },
        { do: "result", outcome: "changes_requested" },
      ],
      [{ do: "result", outcome: "approved" }],
    ],
  };
  const { ended, paths } = await execute(manifest, fakeHarnessAdapters(script));
  assert.equal(ended.result, "success");
  assert.equal(await readFile(join(paths.workspace, "first.txt"), "utf8"), "");
  assert.equal(await readFile(join(paths.workspace, "second.txt"), "utf8"), "[first|true]");
  assert.equal(
    await readFile(join(paths.workspace, "third.txt"), "utf8"),
    "[first|false][second|true]",
  );
});

/** Polls `read` until it gives a value. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 500; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

test("an interrupt stops a command attempt and starts the same step again", async () => {
  const { repo, source, home, runId } = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: 3
    run: sleep 30
`);
  const paths = runPaths(home, runId);
  const running = executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(process.env, 200),
  });
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    return events.some((event) => event.type === "attempt.started") ? true : undefined;
  });
  assert.equal(await requestInterrupt(paths.socket, runId), true);
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8"));
    if (events.filter((event) => event.type === "attempt.started").length !== 2) return undefined;
    const status = JSON.parse(await readFile(paths.status, "utf8").catch(() => "null"));
    return status?.current?.attempt === 2 ? true : undefined;
  });
  const status = JSON.parse(await readFile(paths.status, "utf8"));
  assert.equal(status.current.attempt, 2);
  assert.equal(status.current.stepId, "work");
  assert.equal(await requestCancel(paths.socket, runId), true);
  assert.deepEqual(await running, { result: "cancelled" });
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  assert.deepEqual(
    events.slice(2).map((event) => event.type),
    [
      "attempt.started",
      "attempt.interrupted",
      "attempt.started",
      "attempt.interrupted",
      "run.cancelled",
    ],
  );
});

test("an interrupt stops an agent attempt and starts the same step again", async () => {
  const { repo, source, home, runId } = await setup(`formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: claude
    maxAttempts: 2
    prompt: Work.
    on:
      done: $success
`);
  const paths = runPaths(home, runId);
  const running = executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(process.env, 200),
    adapters: fakeHarnessAdapters({
      work: [[{ do: "sleep", ms: 30_000 }], [{ do: "sleep", ms: 30_000 }]],
    }),
  });
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    return events.some((event) => event.type === "attempt.started") ? true : undefined;
  });
  assert.equal(await requestInterrupt(paths.socket, runId), true);
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8"));
    return events.filter((event) => event.type === "attempt.started").length === 2
      ? true
      : undefined;
  });
  assert.equal(await requestCancel(paths.socket, runId), true);
  assert.deepEqual(await running, { result: "cancelled" });
});

test("an interrupted attempt uses maxAttempts and ends with attempt_limit", async () => {
  const { repo, source, home, runId } = await setup(`formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: 1
    run: sleep 30
`);
  const paths = runPaths(home, runId);
  const running = executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(process.env, 200),
  });
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    return events.some((event) => event.type === "attempt.started") ? true : undefined;
  });
  assert.equal(await requestInterrupt(paths.socket, runId), true);
  assert.deepEqual(await running, { result: "failure" });
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  assert.deepEqual(
    events.slice(2).map((event) => event.type),
    ["attempt.started", "attempt.interrupted", "run.ended"],
  );
  const end = events.at(-1);
  assert.equal(end?.type === "run.ended" && end.reason, "attempt_limit");
});

test("an interrupt stops a Ralph attempt, not just its current iteration", async () => {
  const { repo, source, home, runId } = await setup(`formatVersion: 1
steps:
  - id: loop
    kind: ralph
    harness: claude
    maxAttempts: 2
    maxIterations: 3
    prompt: Loop.
    on:
      done: $success
`);
  const paths = runPaths(home, runId);
  const running = executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(process.env, 200),
    adapters: fakeHarnessAdapters({
      loop: [[{ do: "sleep", ms: 30_000 }], [{ do: "result", outcome: "done" }]],
    }),
  });
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    return events.some((event) => event.type === "iteration.started") ? true : undefined;
  });
  assert.equal(await requestInterrupt(paths.socket, runId), true);
  await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8"));
    return events.filter((event) => event.type === "attempt.started").length === 2
      ? true
      : undefined;
  });
  assert.deepEqual(await running, { result: "success" });
  // Counted after the run ends: the replacement writes attempt.started before its iteration.started.
  const events = parseEventLog(await readFile(paths.events, "utf8"));
  assert.equal(
    events.filter((event) => event.type === "iteration.started").length,
    2,
    "the replacement attempt starts its first iteration, but the interrupted attempt starts no second iteration",
  );
});

test("a cancel on the control socket stops the attempt, kills what ignores SIGTERM, and ends as cancelled", async () => {
  const { repo, source, home, runId } = await setup(`formatVersion: 1
steps:
  - id: stubborn
    kind: command
    run: |
      trap '' TERM
      sleep 30
`);
  const paths = runPaths(home, runId);
  const running = executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(process.env, 200),
  });
  const group = await until(async () => {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    const started = events.find((event) => event.type === "attempt.started");
    return started?.type === "attempt.started" ? started.processGroupId : undefined;
  });
  assert.equal(await requestCancel(paths.socket, runId), true);
  assert.deepEqual(await running, { result: "cancelled" });

  const events = parseEventLog(await readFile(paths.events, "utf8"));
  assert.deepEqual(
    events.slice(2).map((event) => event.type),
    ["attempt.started", "attempt.interrupted", "run.cancelled"],
  );
  assert.equal(groupAlive(group), false, "no process of the attempt's group is left");
  assert.equal(await pathExists(paths.socket), false, "the socket is gone");
  assert.equal(await pathExists(paths.workspace), true, "cancel keeps the workspace");
  const activity = await readFile(paths.activity, "utf8");
  assert.match(activity, /001-stubborn step interrupted\n\S+ run cancelled\n$/);
  assert.equal(JSON.parse(await readFile(paths.status, "utf8")).state, "cancelled");
});

test("a cancel between attempts writes only run.cancelled", async () => {
  const { repo, source, home, runId } = await setup(STRAIGHT("exit 0"));
  const ended = await executeRun({
    home,
    runId,
    source,
    repository: repo,
    executor: localExecutor(),
    cancelSignal: AbortSignal.abort(),
  });
  assert.deepEqual(ended, { result: "cancelled" });
  const events = parseEventLog(await readFile(runPaths(home, runId).events, "utf8"));
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.created", "owner.started", "run.cancelled"],
  );
});

test("a Ralph model is filled again after an earlier iteration puts a new value", async () => {
  const { ended, calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: ralph
    harness: pi
    model: '\${triage.model ?? "initial"}'
    prompt: Triage.
    outputs: [model]
    maxIterations: 2
    on:
      done: $success
`,
    {
      triage: [
        [{ do: "dataPut", key: "triage.model", content: "new-model" }],
        [{ do: "result", outcome: "done" }],
      ],
    },
  );
  assert.equal(ended.result, "success");
  assert.deepEqual(
    calls.map(({ model }) => model),
    ["initial", "new-model"],
  );
});

test("an undefined Ralph model fails before iteration.started and takes onFailure", async () => {
  const { ended, events, calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: agent
    harness: pi
    prompt: Triage.
    outputs: [model]
    onFailure: ralph
    on:
      ready: ralph
  - id: ralph
    kind: ralph
    harness: pi
    model: '\${triage.model}'
    prompt: Work.
    maxIterations: 2
    onFailure: fallback
    on:
      done: $success
  - id: fallback
    kind: command
    run: "true"
`,
    { triage: [[{ do: "exit", code: 1 }]] },
  );
  assert.equal(ended.result, "success");
  assert.equal(calls.length, 1);

  const started = events.find(
    (event) => event.type === "attempt.started" && event.stepId === "ralph",
  );
  assert.ok(started?.type === "attempt.started");
  assert.equal(
    events.some(
      (event) => event.type === "iteration.started" && event.attemptId === started.attemptId,
    ),
    false,
  );
  const attemptEnd = events.find(
    (event) => event.type === "attempt.ended" && event.attemptId === started.attemptId,
  );
  assert.equal(attemptEnd?.type, "attempt.ended");
  assert.equal(attemptEnd?.type === "attempt.ended" && attemptEnd.reason, "bad_field");
  assert.equal(attemptEnd?.type === "attempt.ended" && attemptEnd.field, "model");
  assert.equal(attemptEnd?.type === "attempt.ended" && "value" in attemptEnd, false);
  assert.ok(
    events.some(
      (event) =>
        event.type === "transition" &&
        event.from === "ralph" &&
        event.to === "fallback" &&
        event.cause === "onFailure" &&
        event.reason === "bad_field",
    ),
  );
});

test("an agent's fixed opus model reaches the harness unchanged", async () => {
  const { ended, calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: pi
    model: opus
    effort: high
    args: [--fast]
    prompt: Do the work.
    on:
      done: $success
`,
    { work: [[{ do: "result", outcome: "done" }]] },
  );
  assert.equal(ended.result, "success");
  assert.deepEqual(calls, [{ harness: "pi", model: "opus", effort: "high", args: ["--fast"] }]);
});

test("an agent model expression reads the newest step output value", async () => {
  const { ended, calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: agent
    harness: pi
    model: classifier
    prompt: Triage.
    outputs: [model]
    on:
      ready: work
  - id: work
    kind: agent
    harness: claude
    model: '\${triage.model}'
    prompt: Work.
    on:
      done: $success
`,
    {
      triage: [
        [
          { do: "dataPut", key: "triage.model", content: "older" },
          { do: "dataPut", key: "triage.model", content: "newest" },
          { do: "result", outcome: "ready" },
        ],
      ],
      work: [[{ do: "result", outcome: "done" }]],
    },
  );
  assert.equal(ended.result, "success");
  assert.equal(calls[1]?.model, "newest");
});

test("nullish coalescing supplies opus when the step output has no value", async () => {
  const { ended, calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: agent
    harness: pi
    prompt: Triage.
    outputs: [model]
    onFailure: work
    on:
      ready: work
  - id: work
    kind: agent
    harness: pi
    model: '\${triage.model ?? "opus"}'
    prompt: Work.
    on:
      done: $success
`,
    {
      triage: [[{ do: "exit", code: 1 }]],
      work: [[{ do: "result", outcome: "done" }]],
    },
  );
  assert.equal(ended.result, "success");
  assert.equal(calls[1]?.model, "opus");
});

test("an agent model mixes fixed text with a field value", async () => {
  const { calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: agent
    harness: pi
    prompt: Triage.
    outputs: [size]
    on:
      ready: work
  - id: work
    kind: agent
    harness: pi
    model: claude-\${triage.size}
    prompt: Work.
    on:
      done: $success
`,
    {
      triage: [
        [
          { do: "dataPut", key: "triage.size", content: "large" },
          { do: "result", outcome: "ready" },
        ],
      ],
      work: [[{ do: "result", outcome: "done" }]],
    },
  );
  assert.equal(calls[1]?.model, "claude-large");
});

test("an agent model expression reads a declared input", async () => {
  const { ended, calls } = await executeFake(
    `formatVersion: 1
inputs:
  model: Model to use.
steps:
  - id: work
    kind: agent
    harness: pi
    model: '\${input.model}'
    prompt: Work.
    on:
      done: $success
`,
    { work: [[{ do: "result", outcome: "done" }]] },
    { model: "input-model" },
  );
  assert.equal(ended.result, "success");
  assert.equal(calls[0]?.model, "input-model");
});

test("an empty field value is passed to the harness as an empty model", async () => {
  const { calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: agent
    harness: pi
    prompt: Triage.
    outputs: [model]
    on:
      ready: work
  - id: work
    kind: agent
    harness: pi
    model: '\${triage.model}'
    prompt: Work.
    on:
      done: $success
`,
    {
      triage: [
        [
          { do: "dataPut", key: "triage.model", content: "" },
          { do: "result", outcome: "ready" },
        ],
      ],
      work: [[{ do: "result", outcome: "done" }]],
    },
  );
  assert.deepEqual(calls[1], { harness: "pi", model: "", args: [] });
});

test("an escaped interpolation loads as literal dollar-brace text", async () => {
  const escaped = String.raw`\${input.model}`;
  const { calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: pi
    model: '${escaped}'
    prompt: Work.
    on:
      done: $success
`,
    { work: [[{ do: "result", outcome: "done" }]] },
  );
  assert.equal(calls[0]?.model, `\${input.model}`);
});

test("an undefined model writes a bad_field attempt and takes onFailure without calling the harness", async () => {
  const { ended, events, calls } = await executeFake(
    `formatVersion: 1
steps:
  - id: triage
    kind: agent
    harness: pi
    prompt: Triage.
    outputs: [model]
    onFailure: work
    on:
      ready: work
  - id: work
    kind: agent
    harness: pi
    model: '\${triage.model}'
    prompt: Work.
    onFailure: fallback
    on:
      done: $success
  - id: fallback
    kind: command
    run: "true"
`,
    {
      triage: [[{ do: "exit", code: 1 }]],
    },
  );
  assert.equal(ended.result, "success");
  assert.equal(calls.length, 1);
  const startedIndex = events.findIndex(
    (event) => event.type === "attempt.started" && event.stepId === "work",
  );
  const started = events[startedIndex];
  const attemptEnd = events[startedIndex + 1];
  assert.equal(started?.type === "attempt.started" && started.processGroupId, 0);
  assert.equal(attemptEnd?.type, "attempt.ended");
  assert.equal(attemptEnd?.type === "attempt.ended" && attemptEnd.reason, "bad_field");
  assert.equal(attemptEnd?.type === "attempt.ended" && attemptEnd.field, "model");
  assert.equal(attemptEnd?.type === "attempt.ended" && "value" in attemptEnd, false);
  assert.ok(
    events.some(
      (event) =>
        event.type === "transition" &&
        event.from === "work" &&
        event.to === "fallback" &&
        event.cause === "onFailure" &&
        event.reason === "bad_field",
    ),
  );
});
