import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import { continueCommand } from "./continue-command.ts";
import { interruptCommand } from "./interrupt-command.ts";
import { type LaunchIo, launchCommand } from "./launch-command.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { type RunPaths, runPaths } from "./run-directory.ts";
import { pingOwner, requestCancel } from "./run-owner.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-continue-")));
after(() => removeAfterOwnersExit(root));
let count = 0;
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function io() {
  let out = "";
  let err = "";
  const output = Object.assign(process.stdout, { isTTY: false });
  const input = Object.assign(process.stdin, { isTTY: false });
  const adapter: LaunchIo = {
    out: (text) => (out += text),
    err: (text) => (err += text),
    upgrade: { out: () => undefined, err: () => undefined, isTTY: false, ask: async () => null },
    monitor: { input, output } as MonitorIo,
  };
  return { adapter, out: () => out, err: () => err };
}

async function setup(manifest: string) {
  const dir = join(root, `case-${++count}`);
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const source = join(dir, "source");
  await mkdir(home, { recursive: true });
  await mkdir(repo);
  await mkdir(source);
  const env: NodeJS.ProcessEnv = { ...process.env, ...gitEnv, LOOPFILE_HOME: home };
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  await run("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo, env });
  await writeFile(join(source, "manifest.yaml"), manifest);
  return { dir, home, repo, source, env };
}

async function launch(manifest: string, options: { loopId?: string } = {}) {
  const testCase = await setup(manifest);
  const session = io();
  assert.equal(
    await launchCommand([testCase.source, "-d"], cli, session.adapter, testCase.env, {
      repository: testCase.repo,
      ...options,
    }),
    0,
  );
  const runId = session.out().trim();
  return { ...testCase, runId, paths: runPaths(testCase.home, runId) };
}

async function events(paths: RunPaths): Promise<readonly RunEvent[]> {
  return parseEventLog(await readFile(paths.events, "utf8"));
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let tries = 0; tries < 500; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits for the end event and then for the owner to close its socket, so continue does not see it alive. */
async function waitForEnd(paths: RunPaths, afterSeq = 0) {
  const ended = await until(
    async () =>
      (await events(paths)).findLast(
        (event) =>
          event.seq > afterSeq && (event.type === "run.ended" || event.type === "run.cancelled"),
      ),
    "run to end",
  );
  await until(
    async () => ((await pingOwner(paths.socket, 20)) === undefined ? true : undefined),
    "the owner to stop answering",
  );
  return ended;
}

async function continueRun(runId: string, env: NodeJS.ProcessEnv) {
  const session = io();
  const code = await continueCommand(["continue", runId, "-d"], cli, session.adapter, env, {
    pingTimeoutMs: 200,
  });
  return { code, out: session.out(), err: session.err() };
}

test("continue retries the failed step in the same run, workspace and Materialized Loopfile", async () => {
  const marker = "continued-work-is-here";
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    onFailure: $failure
    run: 'touch ${marker}; if [ "$LOOPFILE_ATTEMPT_ID" = "001-work" ]; then exit 1; fi; test -f ${marker}'
`;
  const testCase = await launch(manifest);
  const before = await waitForEnd(testCase.paths);
  assert.equal(before.type, "run.ended");
  assert.equal(before.reason, "end_state");
  const logBefore = await readFile(testCase.paths.events, "utf8");
  const materializedBefore = await readFile(join(testCase.paths.loopfile, "manifest.yaml"), "utf8");
  await stat(join(testCase.paths.workspace, marker));
  const createdBefore = (await events(testCase.paths))[0];
  assert.equal(createdBefore?.type, "run.created");
  const workspace = testCase.paths.workspace;

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, `${testCase.runId}\n`);
  assert.match(result.err, new RegExp(`^continued: ${testCase.runId}\\n`));
  const end = await waitForEnd(testCase.paths, parseEventLog(logBefore).at(-1)?.seq);
  assert.equal(end.type, "run.ended");
  const all = await events(testCase.paths);
  const added = all.slice(parseEventLog(logBefore).length);
  assert.deepEqual(
    added.slice(0, 3).map((event) => event.type),
    ["owner.started", "run.continued", "attempt.started"],
  );
  assert.deepEqual(all[0], createdBefore);
  assert.ok((await readFile(testCase.paths.events, "utf8")).startsWith(logBefore));
  assert.equal(
    await readFile(join(testCase.paths.loopfile, "manifest.yaml"), "utf8"),
    materializedBefore,
  );
  assert.ok(workspace.startsWith(testCase.paths.root));
  assert.equal(all.filter((event) => event.type === "attempt.started").length, 2);
  assert.equal(all.filter((event) => event.type === "run.continued").length, 1);
});

test("continue replaces a cancelled attempt even when its prior attempt limit was reached", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: 1
    run: 'if [ "$LOOPFILE_ATTEMPT_ID" = "001-work" ]; then sleep 30; fi'
`;
  const testCase = await launch(manifest);
  await until(
    async () =>
      (await events(testCase.paths)).some((event) => event.type === "attempt.started") || undefined,
    "the cancelled attempt to start",
  );
  assert.equal(await requestCancel(testCase.paths.socket, testCase.runId), true);
  const stopped = await waitForEnd(testCase.paths);
  assert.equal(stopped.type, "run.cancelled");

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  assert.equal((await waitForEnd(testCase.paths, stopped.seq)).type, "run.ended");
  const all = await events(testCase.paths);
  assert.deepEqual(
    all
      .filter((event) => event.type === "attempt.started")
      .map((event) => event.type === "attempt.started" && event.attemptId),
    ["001-work", "002-work"],
  );
  assert.equal(all.filter((event) => event.type === "run.continued").length, 1);
});

test("continue retries the attempt stopped by run_timeout with a fresh timeout", async () => {
  const manifest = `formatVersion: 1
runTimeout: 1s
steps:
  - id: work
    kind: command
    maxAttempts: 1
    run: 'if [ "$LOOPFILE_ATTEMPT_ID" = "001-work" ]; then sleep 10; fi'
`;
  const testCase = await launch(manifest);
  const stopped = await waitForEnd(testCase.paths);
  assert.equal(stopped.type, "run.ended");
  assert.equal(stopped.reason, "run_timeout");
  assert.ok((await events(testCase.paths)).some((event) => event.type === "attempt.interrupted"));

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  assert.equal((await waitForEnd(testCase.paths, stopped.seq)).type, "run.ended");
  assert.equal(
    (await events(testCase.paths)).filter((event) => event.type === "attempt.started").length,
    2,
  );
});

test("continue routes a transition_limit result instead of starting that step again", async () => {
  const manifest = `formatVersion: 1
maxTransitions: 1
steps:
  - id: prep
    kind: command
    run: 'true'
  - id: work
    kind: command
    run: 'true'
`;
  const testCase = await launch(manifest);
  const stopped = await waitForEnd(testCase.paths);
  assert.equal(stopped.type, "run.ended");
  assert.equal(stopped.reason, "transition_limit");
  const logBefore = await readFile(testCase.paths.events, "utf8");

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  const terminal = await waitForEnd(testCase.paths, stopped.seq);
  assert.equal(terminal.type, "run.ended");
  assert.equal(terminal.result, "success");
  const added = (await events(testCase.paths)).slice(parseEventLog(logBefore).length);
  assert.deepEqual(
    added.map((event) => event.type),
    ["owner.started", "run.continued", "transition", "run.ended"],
  );
  assert.equal(added.find((event) => event.type === "transition")?.type, "transition");
  assert.equal(
    added.some((event) => event.type === "attempt.started"),
    false,
  );
});

test("continue routes the attempt outcome to $failure by retrying that step", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: 1
    on:
      blocked: $failure
      done: $success
    run: 'if [ "$LOOPFILE_ATTEMPT_ID" = "001-work" ]; then node ${cli} result blocked; else node ${cli} result done; fi'
`;
  const testCase = await launch(manifest);
  const stopped = await waitForEnd(testCase.paths);
  assert.equal(stopped.type, "run.ended");
  assert.equal(stopped.result, "failure");
  const firstAttempt = (await events(testCase.paths)).find(
    (event) => event.type === "attempt.ended",
  );
  assert.equal(firstAttempt?.type === "attempt.ended" && firstAttempt.reason, "outcome");

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  await waitForEnd(testCase.paths, stopped.seq);
  assert.equal(
    (await events(testCase.paths)).filter((event) => event.type === "attempt.started").length,
    2,
  );
});

test("continue gives an attempt_limit run its maxAttempts again", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: 1
    on:
      again: work
      done: $success
    run: 'if [ "$LOOPFILE_ATTEMPT_ID" = "001-work" ]; then node ${cli} result again; else node ${cli} result done; fi'
`;
  const testCase = await launch(manifest);
  const stopped = await waitForEnd(testCase.paths);
  assert.equal(stopped.type, "run.ended");
  assert.equal(stopped.reason, "attempt_limit");
  assert.equal(stopped.stepId, "work");

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  const terminal = await waitForEnd(testCase.paths, stopped.seq);
  assert.equal(terminal.type, "run.ended");
  assert.equal(terminal.result, "success", JSON.stringify(await events(testCase.paths)));
  assert.deepEqual(
    (await events(testCase.paths))
      .filter((event) => event.type === "attempt.started")
      .map((event) => event.type === "attempt.started" && event.attemptId),
    ["001-work", "002-work"],
  );
});

test("continue may be repeated after the continued run ends again", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    onFailure: $failure
    run: 'if [ "$LOOPFILE_ATTEMPT_ID" = "003-work" ]; then exit 0; else exit 1; fi'
`;
  const testCase = await launch(manifest);
  const firstEnd = await waitForEnd(testCase.paths);
  assert.equal(firstEnd.type, "run.ended");
  assert.equal((await continueRun(testCase.runId, testCase.env)).code, 0);
  const secondEnd = await waitForEnd(testCase.paths, firstEnd.seq);
  assert.equal(secondEnd.type, "run.ended");
  assert.equal((await continueRun(testCase.runId, testCase.env)).code, 0);
  const terminal = await waitForEnd(testCase.paths, secondEnd.seq);
  assert.equal(terminal.type, "run.ended");
  assert.equal(terminal.result, "success");
  assert.equal(
    (await events(testCase.paths)).filter((event) => event.type === "run.continued").length,
    2,
  );
});

test("a continued run that is running can be interrupted", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    maxAttempts: 3
    onFailure: $failure
    run: 'if [ "$LOOPFILE_ATTEMPT_ID" = "001-work" ]; then exit 1; fi; sleep 30'
`;
  const testCase = await launch(manifest);
  const firstEnd = await waitForEnd(testCase.paths);
  assert.equal((await continueRun(testCase.runId, testCase.env)).code, 0);
  await until(
    async () =>
      (await events(testCase.paths)).some(
        (event) => event.type === "attempt.started" && event.attemptId === "002-work",
      )
        ? true
        : undefined,
    "the continued attempt",
  );
  let err = "";
  const code = await interruptCommand(
    ["interrupt", testCase.runId],
    () => undefined,
    (text) => {
      err += text;
    },
    testCase.env,
  );
  assert.equal(code, 0, err);
  assert.equal(err, `interrupted: ${testCase.runId}\n`);
  assert.equal(await requestCancel(testCase.paths.socket, testCase.runId), true);
  assert.equal((await waitForEnd(testCase.paths, firstEnd.seq)).type, "run.cancelled");
});

test("run_timeout between attempts takes the unfinished route rather than repeating the attempt", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: work
    kind: command
    onFailure: $failure
    run: exit 1
`;
  const testCase = await launch(manifest);
  await waitForEnd(testCase.paths);
  const before = await events(testCase.paths);
  const lastAttemptEnd = before.findLastIndex((event) => event.type === "attempt.ended");
  const at = before.at(-1)?.at ?? new Date().toISOString();
  const cut = [
    ...before.slice(0, lastAttemptEnd + 1),
    { type: "run.ended", seq: lastAttemptEnd + 2, at, result: "failure", reason: "run_timeout" },
  ];
  await writeFile(
    testCase.paths.events,
    `${cut.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const logBefore = await readFile(testCase.paths.events, "utf8");

  const result = await continueRun(testCase.runId, testCase.env);
  assert.equal(result.code, 0, result.err);
  const terminal = await waitForEnd(testCase.paths, parseEventLog(logBefore).at(-1)?.seq);
  assert.equal(terminal.type, "run.ended");
  const added = (await events(testCase.paths)).slice(parseEventLog(logBefore).length);
  assert.deepEqual(
    added.map((event) => event.type),
    ["owner.started", "run.continued", "transition", "run.ended"],
  );
  assert.equal(
    added.some((event) => event.type === "attempt.started"),
    false,
  );
});

test("completed runs refuse continue and suggest starting a new run", async () => {
  const testCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: 'true'\n`,
  );
  await waitForEnd(testCase.paths);
  const refused = await continueRun(testCase.runId, testCase.env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /completed and cannot be continued/);
  assert.match(refused.err, /Start a new run/);
});

test("running runs refuse continue and name interrupt", async () => {
  const testCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 30\n`,
  );
  await until(
    async () =>
      (await events(testCase.paths)).some((event) => event.type === "attempt.started") || undefined,
    "the active attempt",
  );
  const refused = await continueRun(testCase.runId, testCase.env);
  assert.equal(refused.code, 2);
  assert.match(refused.err, new RegExp(`loopfile interrupt ${testCase.runId}`));
  assert.equal(await requestCancel(testCase.paths.socket, testCase.runId), true);
  await waitForEnd(testCase.paths);
});

test("crashed runs refuse continue and name resume", async () => {
  const testCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 30\n`,
  );
  await until(async () => {
    const all = await events(testCase.paths);
    const owner = all.find((event) => event.type === "owner.started");
    const attempt = all.find((event) => event.type === "attempt.started");
    return owner?.type === "owner.started" && attempt?.type === "attempt.started"
      ? { owner: owner.pid, group: attempt.processGroupId }
      : undefined;
  }, "the active owner and attempt").then(async ({ owner, group }) => {
    process.kill(owner, "SIGKILL");
    process.kill(-group, "SIGKILL");
  });
  await until(
    async () => ((await pingOwner(testCase.paths.socket, 200)) === undefined ? true : undefined),
    "the owner to stop answering",
  );
  const refused = await continueRun(testCase.runId, testCase.env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`loopfile resume ${testCase.runId}`));
});

test("internal_error refuses continue and names resume", async () => {
  const testCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    onFailure: $failure\n    run: exit 1\n`,
  );
  await waitForEnd(testCase.paths);
  const changed = (await events(testCase.paths)).map((event) =>
    event.type === "run.ended" ? { ...event, reason: "internal_error" as const } : event,
  );
  await writeFile(
    testCase.paths.events,
    `${changed.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const refused = await continueRun(testCase.runId, testCase.env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /internal_error/);
  assert.match(refused.err, new RegExp(`loopfile resume ${testCase.runId}`));
});

test("changed event format and model refuse continue", async () => {
  const eventCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: exit 1\n`,
  );
  await waitForEnd(eventCase.paths);
  const eventsWithNewFormat = (await events(eventCase.paths)).map((event) =>
    event.type === "run.created" ? { ...event, eventFormatVersion: 99 } : event,
  );
  await writeFile(
    eventCase.paths.events,
    `${eventsWithNewFormat.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const formatRefusal = await continueRun(eventCase.runId, eventCase.env);
  assert.equal(formatRefusal.code, 2);
  assert.match(formatRefusal.err, /event format version 99/);

  const modelCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: exit 1\n`,
  );
  await waitForEnd(modelCase.paths);
  const materialized = join(modelCase.paths.loopfile, "manifest.yaml");
  await writeFile(
    materialized,
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: exit 2\n`,
  );
  const modelRefusal = await continueRun(modelCase.runId, modelCase.env);
  assert.equal(modelRefusal.code, 2);
  assert.match(modelRefusal.err, /no longer builds the model the run started with/);
});

test("child runs refuse individual continuation", async () => {
  const testCase = await launch(
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: exit 1\n`,
    { loopId: "parent-loop" },
  );
  await waitForEnd(testCase.paths);
  const refused = await continueRun(testCase.runId, testCase.env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /child of loop parent-loop/);
  assert.match(refused.err, /owns this child run/);
});

test("the replacement prompt keeps the previous transition and data, changing only attempt.number", async () => {
  const testCase = await setup(`formatVersion: 1
steps:
  - id: prep
    kind: command
    run: 'printf same-data > saved.txt; node ${cli} data put prep.note saved.txt'
    outputs: [note]
  - id: review
    kind: agent
    harness: claude
    on:
      approved: $success
    onFailure: $failure
    prompt: '{{ prep.note }}|{{ $run.previous.stepId }}|{{ $run.previous.reason }}|{{ $run.attempt.number }}'
`);
  const bin = join(testCase.dir, "bin");
  const captures = join(testCase.dir, "prompts");
  await mkdir(bin);
  await mkdir(captures);
  const fake = join(bin, "claude");
  await writeFile(
    fake,
    `#!/bin/sh\ncat > "$CAPTURE_DIR/$LOOPFILE_ATTEMPT_ID"\n[ "$LOOPFILE_ATTEMPT_ID" = "002-review" ] && exit 1\nnode ${cli} result approved\n`,
  );
  await chmod(fake, 0o755);
  testCase.env.PATH = `${bin}:${testCase.env.PATH}`;
  testCase.env.CAPTURE_DIR = captures;
  const session = io();
  assert.equal(
    await launchCommand([testCase.source, "-d"], cli, session.adapter, testCase.env, {
      repository: testCase.repo,
    }),
    0,
    session.err(),
  );
  const runId = session.out().trim();
  const paths = runPaths(testCase.home, runId);
  const firstEnd = await waitForEnd(paths);
  assert.equal(firstEnd.type, "run.ended");
  await stat(join(captures, "002-review")).catch(async () => {
    assert.fail(JSON.stringify(await events(paths)));
  });
  const replaced = await readFile(join(captures, "002-review"), "utf8");

  const continued = await continueRun(runId, testCase.env);
  assert.equal(continued.code, 0, JSON.stringify(continued));
  await waitForEnd(paths, firstEnd.seq);
  const replacement = await readFile(join(captures, "003-review"), "utf8");
  assert.equal(replaced, "same-data|prep|clean_exit|1");
  assert.equal(replacement, "same-data|prep|clean_exit|2");
  assert.equal(
    replaced.slice(0, replaced.lastIndexOf("|")),
    replacement.slice(0, replacement.lastIndexOf("|")),
  );
});
