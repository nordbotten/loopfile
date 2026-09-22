import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loopStatus } from "../application/loop-status.ts";
import { parseEventLog } from "../application/replay.ts";
import type { LoopEvent } from "../domain/events.ts";
import { loopCommand } from "./loop-command.ts";
import { loopPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
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
  for (let tries = 0; tries < 800; tries += 1) {
    const events = parseEventLog<LoopEvent>(await readFile(path, "utf8").catch(() => ""));
    if (events.at(-1)?.type === "loop.ended") return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the loop did not end");
}

test("loop --list starts one run per JSON line with its own input set", async () => {
  const setupResult = await setup(`formatVersion: 1
inputs:
  issue: The issue number
steps:
  - id: work
    kind: command
    run: 'test -n "$(node ${cli} data get input.issue)"'
`);
  const list = join(setupResult.root, "inputs.jsonl");
  await writeFile(list, '{"issue":"41"}\n\n{"issue":"42"}\n{"issue":"43"}\n');
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--list", list, "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 0, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    const created = events[0];
    assert.deepEqual(created?.type === "loop.created" ? created.source : undefined, {
      kind: "list",
      sets: [{ issue: "41" }, { issue: "42" }, { issue: "43" }],
    });
    const started = events.filter(
      (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
        event.type === "loop.run_started",
    );
    assert.deepEqual(
      started.map((event) => event.inputSet),
      [{ issue: "41" }, { issue: "42" }, { issue: "43" }],
    );
    for (const event of started) {
      const child = parseEventLog(
        await readFile(runPaths(setupResult.home, event.runId).events, "utf8"),
      );
      assert.equal(child.at(-1)?.type, "run.ended");
      assert.equal(
        await readFile(join(runPaths(setupResult.home, event.runId).inputs, "issue"), "utf8"),
        event.inputSet.issue,
      );
    }
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("a bad list line fails before any loop folder exists", async () => {
  const setupResult = await setup(`formatVersion: 1
inputs:
  issue: The issue number
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const list = join(setupResult.root, "inputs.jsonl");
  await writeFile(list, '{"issue":"41"}\n42\n{"issue":"43"}\n');
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--list", list, "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 2);
    assert.match(captured.errors(), /error: line 2: input set is not a JSON object/);
    assert.match(captured.errors(), /code: bad_argument/);
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("an input given by both --input and a list line fails before a loop starts", async () => {
  const setupResult = await setup(`formatVersion: 1
inputs:
  issue: The issue number
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const list = join(setupResult.root, "inputs.jsonl");
  await writeFile(list, '{"issue":"41"}\n');
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--list", list, "--input", "issue=42", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 2);
    assert.match(
      captured.errors(),
      /line 1: input \\"issue\\" is given by both --input and the input source/,
    );
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("an empty or unreadable list is a bad argument before a loop starts", async () => {
  const setupResult = await setup();
  const empty = join(setupResult.root, "empty.jsonl");
  await writeFile(empty, "\n  \n");
  try {
    for (const [list, message] of [
      [empty, "the list has no input sets"],
      [join(setupResult.root, "missing.jsonl"), "cannot read"],
    ] as const) {
      const captured = io();
      const code = await loopCommand(
        ["loop", setupResult.source, "--list", list, "-d"],
        cli,
        captured.value,
        setupResult.env,
        { repository: setupResult.repo },
      );
      assert.equal(code, 2);
      assert.match(captured.errors(), new RegExp(message));
    }
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("loop --times starts a detached owner and two command runs", async () => {
  const setupResult = await setup();
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
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
    for (const { args, message } of [
      { args: ["-d"], message: "a loop needs one input source: --times, --list or --next" },
      { args: ["--times", "0", "-d"], message: "--times must be an integer of 1 or more" },
      {
        args: ["--times", "2", "--list", "items", "-d"],
        message: "a loop takes only one input source",
      },
      { args: ["--input", "missing=value", "--times", "2", "-d"], message: "--input missing" },
    ]) {
      const captured = io();
      const code = await loopCommand(
        ["loop", setupResult.source, ...args],
        cli,
        captured.value,
        setupResult.env,
        { repository: setupResult.repo },
      );
      assert.equal(code, 2, captured.errors());
      assert.match(captured.errors(), new RegExp(`error: .*${message}`));
      assert.match(captured.errors(), /code: bad_argument/);
    }
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("attached loops are refused with the documented help", async () => {
  const setupResult = await setup();
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 2);
    assert.equal(
      captured.errors(),
      "error: attached loops are not built yet\n" +
        "code: bad_argument\n" +
        "help: attached loops are not built yet: add -d\n",
    );
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});

test("a bad manifest stops before any loop folder is made", async () => {
  const setupResult = await setup(`formatVersion: 1
name: invalid
maxTransitions: 0
steps:
  - id: work
    kind: command
    run: 'true'
`);
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 1);
    assert.deepEqual(captured.errors().split("\n").slice(0, 2), [
      "error: line 2: name: unknown field `name`",
      "error: line 3: maxTransitions: maxTransitions must be an integer of 1 or more",
    ]);
    assert.match(captured.errors(), /\ncode: invalid_manifest\n/);
    await assert.rejects(stat(join(setupResult.home, "loops")));
  } finally {
    await rm(setupResult.root, { recursive: true, force: true });
  }
});
