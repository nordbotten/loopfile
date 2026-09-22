import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loopStatus } from "../application/loop-status.ts";
import { parseEventLog } from "../application/replay.ts";
import { main } from "../cli.ts";
import type { LoopEvent } from "../domain/events.ts";
import { loopPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

const run = promisify(execFile);
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function setup(
  manifest = "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 0.2\n",
) {
  const root = await mkdtemp(join(tmpdir(), "loopfile-loop-command-"));
  const repo = join(root, "repo");
  const source = join(root, "source");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
  });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await run("git", ["commit", "-q", "-m", "first"], {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
  });
  await writeFile(join(source, "manifest.yaml"), manifest);
  return {
    root,
    repo,
    source,
    home,
    env: { ...process.env, ...gitEnv, LOOPFILE_HOME: home },
  };
}

function io() {
  let output = "";
  let errors = "";
  return {
    value: {
      out: (text: string | Uint8Array) => {
        output += typeof text === "string" ? text : Buffer.from(text).toString();
      },
      err: (text: string) => {
        errors += text;
      },
      upgrade: {
        out: () => undefined,
        err: (text: string) => {
          errors += text;
        },
        isTTY: false,
        ask: async () => null,
      },
    },
    output: () => output,
    errors: () => errors,
  };
}

async function waitForEnd(home: string, loopId: string): Promise<readonly LoopEvent[]> {
  const path = loopPaths(home, loopId).events;
  for (let tries = 0; tries < 200; tries += 1) {
    const events = parseEventLog<LoopEvent>(await readFile(path, "utf8").catch(() => ""));
    if (events.at(-1)?.type === "loop.ended") return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the loop did not end");
}

test("loop --times starts a detached owner and two command runs", async () => {
  const setupResult = await setup();
  try {
    const captured = io();
    const code = await main(
      ["loop", setupResult.source, "--times", "2", "-d"],
      captured.value.out,
      captured.value.err,
      setupResult.env,
    );
    assert.equal(code, 0, captured.errors());
    const loopId = captured.output().trim();
    assert.match(loopId, /^loop-\d{8}-\d{6}-/);
    assert.match(captured.errors(), new RegExp(`started: ${loopId}`));

    let pinged = false;
    for (let tries = 0; tries < 20; tries += 1) {
      if ((await pingOwner(loopPaths(setupResult.home, loopId).socket)) === loopId) {
        pinged = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(pinged, true);

    const events = await waitForEnd(setupResult.home, loopId);
    const started = events.filter(
      (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
        event.type === "loop.run_started",
    );
    assert.equal(started.length, 2);
    assert.equal(loopStatus(events).state, "completed");
    for (const child of started) {
      const childEvents = parseEventLog(
        await readFile(runPaths(setupResult.home, child.runId).events, "utf8"),
      );
      assert.equal(childEvents.at(-1)?.type, "run.ended");
    }
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("loop input errors happen before a loop folder exists", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: 'true'\n",
  );
  try {
    for (const args of [
      ["--times", "0", "-d"],
      ["--times", "2", "--list", "items", "-d"],
      ["--input", "missing=value", "--times", "2", "-d"],
    ]) {
      const captured = io();
      const code = await main(
        ["loop", setupResult.source, ...args],
        captured.value.out,
        captured.value.err,
        setupResult.env,
      );
      assert.equal(code, 2, captured.errors());
      assert.match(captured.errors(), /code: bad_argument/);
    }
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});
