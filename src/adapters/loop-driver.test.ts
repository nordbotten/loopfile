import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { loopStatus } from "../application/loop-status.ts";
import { parseEventLog } from "../application/replay.ts";
import type { LoopEvent } from "../domain/events.ts";
import { materializeDirectory } from "./directory-loader.ts";
import { openEventLog } from "./event-log.ts";
import { runLoop } from "./loop-run.ts";
import { loopPaths, runPaths } from "./run-directory.ts";

const run = promisify(execFile);
const cli = await realpath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const root = await mkdtemp(join(tmpdir(), "loopfile-loop-run-"));
after(() => rm(root, { recursive: true, force: true }));
let count = 0;

async function setup(
  command: string,
  sourceText = `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: ${JSON.stringify(command)}\n`,
) {
  count += 1;
  const base = join(root, `case-${count}`);
  const repo = join(base, "repo");
  const source = join(base, "source");
  const home = join(base, "home");
  const loopId = `loop-20260922-100000-c${count}xx`;
  await mkdir(repo, { recursive: true });
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await run("git", ["commit", "-q", "-m", "first"], {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
  });
  await writeFile(join(source, "manifest.yaml"), sourceText);

  const paths = loopPaths(home, loopId);
  await mkdir(paths.root, { recursive: true });
  await materializeDirectory(source, paths.loopfile);
  const log = await openEventLog<LoopEvent>(paths.events);
  await log.append({
    type: "loop.created",
    loopId,
    eventFormatVersion: 1,
    repositoryPath: repo,
    loopfileName: "source",
    source: { kind: "times", count: 3 },
    fixedInputs: {},
    retry: 0,
    maxRuns: null,
    pauseMs: null,
    program: { version: "test", digest: "test" },
  });
  await log.close();
  return { env: { ...process.env, ...gitEnv, LOOPFILE_HOME: home }, home, loopId };
}

async function loopEvents(home: string, loopId: string): Promise<readonly LoopEvent[]> {
  return parseEventLog<LoopEvent>(await readFile(loopPaths(home, loopId).events, "utf8"));
}

test("runs times children in order and records their loop links", async () => {
  const setupResult = await setup("sleep 0.05");
  const ended = await runLoop(setupResult.home, setupResult.loopId, {
    cli,
    env: setupResult.env,
  });
  const events = await loopEvents(setupResult.home, setupResult.loopId);
  const runStarted = events.filter(
    (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
      event.type === "loop.run_started",
  );
  assert.equal(runStarted.length, 3);
  assert.equal(events.at(-1)?.type, "loop.ended");
  assert.deepEqual(ended, loopStatus(events));
  assert.equal(ended.state, "completed");
  assert.equal(ended.endReason, "source_empty");

  let previousEnd = 0;
  for (const event of runStarted) {
    const paths = runPaths(setupResult.home, event.runId);
    const child = parseEventLog(await readFile(paths.events, "utf8"));
    const created = child.find((candidate) => candidate.type === "run.created");
    const childEnd = child.at(-1);
    assert.equal(created?.type, "run.created");
    assert.deepEqual(
      created?.type === "run.created"
        ? { loopId: created.loopId, loopIndex: created.loopIndex }
        : undefined,
      { loopId: setupResult.loopId, loopIndex: event.index },
    );
    assert.equal(childEnd?.type, "run.ended");
    const startedAt = Date.parse(created?.at ?? "");
    const endedAt = Date.parse(childEnd?.at ?? "");
    assert.ok(startedAt <= endedAt);
    assert.ok(previousEnd <= startedAt, "children overlap");
    previousEnd = endedAt;
  }

  const status = JSON.parse(
    await readFile(loopPaths(setupResult.home, setupResult.loopId).status, "utf8"),
  );
  assert.deepEqual(status, ended);
});

test("stops after the first failed child", async () => {
  const setupResult = await setup("exit 1");
  const ended = await runLoop(setupResult.home, setupResult.loopId, {
    cli,
    env: setupResult.env,
  });
  const events = await loopEvents(setupResult.home, setupResult.loopId);
  assert.equal(events.filter((event) => event.type === "loop.run_started").length, 1);
  assert.equal(ended.state, "failed");
  assert.equal(ended.endReason, "run_failed");
  assert.match(ended.detail ?? "", /^run .+ failed$/);
  assert.deepEqual(ended, loopStatus(events));
});
