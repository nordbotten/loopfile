import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loopStatus } from "../application/loop-status.ts";
import { parseEventLog } from "../application/replay.ts";
import type { LoopEvent } from "../domain/events.ts";
import { childEndState, loopCommand } from "./loop-command.ts";
import { ownerPids, removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { loopPaths, runPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";
import { tailCommand } from "./tail-command.ts";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
/**
 * The ping bound for an attached loop. A gone owner refuses the connection at
 * once and a live one answers, so this bound only ends a ping to a live owner
 * that is slow under load, and a slow owner is not a gone one.
 */
const LIVE_PING_MS = 30_000;
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

function io(onError: (text: string) => void = () => undefined) {
  let output = "";
  let errors = "";
  return {
    value: {
      out: (text: string | Uint8Array) => {
        output += typeof text === "string" ? text : Buffer.from(text).toString();
      },
      err: (text: string) => {
        errors += text;
        onError(text);
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
    if (events.at(-1)?.type === "loop.ended") {
      for (let ownerTries = 0; ownerTries < 50; ownerTries += 1) {
        if ((await pingOwner(loopPaths(home, loopId).socket, 20)) === undefined) return events;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("the loop owner did not close");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the loop did not end");
}

async function waitForRunStart(home: string, loopId: string): Promise<void> {
  const path = loopPaths(home, loopId).events;
  for (let tries = 0; tries < 800; tries += 1) {
    const events = parseEventLog<LoopEvent>(await readFile(path, "utf8").catch(() => ""));
    if (events.some((event) => event.type === "loop.run_started")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the first loop run did not start");
}

async function waitForPause(
  home: string,
  loopId: string,
): Promise<Extract<LoopEvent, { type: "loop.paused" }>> {
  const path = loopPaths(home, loopId).events;
  for (let tries = 0; tries < 800; tries += 1) {
    const event = parseEventLog<LoopEvent>(await readFile(path, "utf8").catch(() => "")).find(
      (candidate): candidate is Extract<LoopEvent, { type: "loop.paused" }> =>
        candidate.type === "loop.paused",
    );
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the loop did not pause");
}

async function waitForOwnerGone(home: string, loopId: string): Promise<void> {
  for (let tries = 0; tries < 800; tries += 1) {
    if ((await pingOwner(loopPaths(home, loopId).socket, 10)) !== loopId) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the loop owner did not stop");
}

/**
 * SIGKILLs the loop owner once its first child run owner has started, so no
 * child can start after the kill and the test knows every owner that can
 * still write into its folder.
 */
async function killLoopOwner(home: string, loopId: string): Promise<void> {
  for (let tries = 0; tries < 800; tries += 1) {
    const events = parseEventLog<LoopEvent>(
      await readFile(loopPaths(home, loopId).events, "utf8").catch(() => ""),
    );
    const child = events.find((event) => event.type === "loop.run_started");
    const [owner] = await ownerPids(loopPaths(home, loopId).events);
    if (
      owner !== undefined &&
      child?.type === "loop.run_started" &&
      (await ownerPids(runPaths(home, child.runId).events)).length > 0
    ) {
      process.kill(owner, "SIGKILL");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the first child run owner did not start");
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
    await removeAfterOwnersExit(setupResult.root);
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
    await removeAfterOwnersExit(setupResult.root);
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
    await removeAfterOwnersExit(setupResult.root);
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
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("loop --next consumes command input sets until stdout is empty", async () => {
  const setupResult = await setup(`formatVersion: 1
inputs:
  n: The number
steps:
  - id: work
    kind: command
    run: 'test -n "$(node ${cli} data get input.n)"'
`);
  const script = join(setupResult.repo, "next.sh");
  await writeFile(
    script,
    `#!/bin/sh
count=$(cat .next-count 2>/dev/null || echo 0)
printf '%s\\n' "$((count + 1))" > .next-count
printf '%s|%s\\n' "$PWD" "$LOOPFILE_LOOP_ID" > .next-seen
if [ "$count" -ge 2 ]; then
  printf '  \\n'
else
  printf '{"n":"%s"}\\n' "$((count + 1))"
fi
printf 'next stderr\\n' >&2
`,
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--next", "sh next.sh", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 0, captured.errors());
    const loopId = captured.output().trim();
    const events = await waitForEnd(setupResult.home, loopId);
    const started = events.filter(
      (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
        event.type === "loop.run_started",
    );
    assert.deepEqual(
      started.map((event) => event.inputSet),
      [{ n: "1" }, { n: "2" }],
    );
    assert.equal(loopStatus(events).state, "completed");
    assert.equal(loopStatus(events).endReason, "source_empty");
    assert.equal((await readFile(join(setupResult.repo, ".next-count"), "utf8")).trim(), "3");
    assert.equal(
      (await readFile(join(setupResult.repo, ".next-seen"), "utf8")).trim(),
      `${setupResult.repo}|${loopId}`,
    );
    assert.match(
      await readFile(loopPaths(setupResult.home, loopId).ownerLog, "utf8"),
      /next stderr/,
    );
    assert.deepEqual(events[0]?.type === "loop.created" ? events[0].source : undefined, {
      kind: "next",
      command: "sh next.sh",
    });
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("max runs stops --next before it is called again", async () => {
  const setupResult = await setup();
  const script = join(setupResult.repo, "next-once.sh");
  await writeFile(
    script,
    `#!/bin/sh
count=$(cat .next-count 2>/dev/null || echo 0)
printf '%s\\n' "$((count + 1))" > .next-count
printf '{}\\n'
`,
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--next", "sh next-once.sh", "--max-runs", "1", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 0, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 1);
    assert.equal(loopStatus(events).endReason, "max_runs");
    assert.equal((await readFile(join(setupResult.repo, ".next-count"), "utf8")).trim(), "1");
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("a failing --next command ends the loop without starting a run", async () => {
  const setupResult = await setup();
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--next", "exit 3", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 0, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 0);
    assert.equal(loopStatus(events).state, "failed");
    assert.equal(loopStatus(events).endReason, "source_failed");
    assert.equal(loopStatus(events).detail, "--next exited 3");
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("a non-string --next value fails before starting a run", async () => {
  const setupResult = await setup(`formatVersion: 1
inputs:
  n: The number
steps:
  - id: work
    kind: command
    run: 'true'
`);
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--next", "printf '%s' '{\"n\":1}'", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo },
    );
    assert.equal(code, 0, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 0);
    assert.equal(loopStatus(events).endReason, "source_failed");
    assert.equal(loopStatus(events).detail, 'input "n" is not a string');
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("a changed CLI ends a loop before its second run", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 0.3\n",
  );
  const cliCopy = join(dirname(cli), `.cli-copy-${process.pid}-${Date.now()}.ts`);
  await copyFile(cli, cliCopy);
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2", "-d"],
      cliCopy,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10 },
    );
    assert.equal(code, 0, captured.errors());
    const loopId = captured.output().trim();
    await waitForRunStart(setupResult.home, loopId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const changed = await readFile(cliCopy);
    changed[changed.length - 1] = 0x20;
    await writeFile(cliCopy, changed);

    const events = await waitForEnd(setupResult.home, loopId);
    const ended = events.at(-1);
    assert.equal(ended?.type, "loop.ended");
    assert.equal(ended?.type === "loop.ended" ? ended.reason : undefined, "program_changed");
    assert.equal(
      ended?.type === "loop.ended" ? ended.detail : undefined,
      `loopfile changed from ${version} to ${version}`,
    );
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 1);
    await waitForOwnerGone(setupResult.home, loopId);
  } finally {
    await rm(cliCopy, { force: true });
    await removeAfterOwnersExit(setupResult.root);
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
    assert.equal(events[0]?.type === "loop.created" ? events[0].maxRuns : undefined, null);
    assert.equal(loopStatus(events).state, "completed");
    for (const child of started) {
      const childEvents = parseEventLog(
        await readFile(runPaths(setupResult.home, child.runId).events, "utf8"),
      );
      assert.equal(childEvents.at(-1)?.type, "run.ended");
    }
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("pauses between runs and exposes the pause in status", async () => {
  const setupResult = await setup();
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2", "--pause", "1s", "-d"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: 50 },
    );
    assert.equal(code, 0, captured.errors());
    const loopId = captured.output().trim();
    const paused = await waitForPause(setupResult.home, loopId);
    const status = JSON.parse(await readFile(loopPaths(setupResult.home, loopId).status, "utf8"));
    assert.equal(status.state, "running");
    assert.equal(status.pausedUntil, paused.until);

    const events = await waitForEnd(setupResult.home, loopId);
    const started = events.filter(
      (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
        event.type === "loop.run_started",
    );
    assert.equal(started.length, 2);
    assert.equal(events.filter((event) => event.type === "loop.paused").length, 1);
    assert.equal(events[0]?.type === "loop.created" ? events[0].pauseMs : undefined, 1000);
    const firstChild = parseEventLog(
      await readFile(runPaths(setupResult.home, started[0]?.runId ?? "").events, "utf8"),
    );
    const firstEnded = firstChild.at(-1);
    assert.equal(firstEnded?.type, "run.ended");
    assert.ok(Date.parse(started[1]?.at ?? "") - Date.parse(firstEnded?.at ?? "") >= 1000);
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("tail follows a running times loop through both children", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 0.05\n",
  );
  try {
    const started = io();
    assert.equal(
      await loopCommand(
        ["loop", setupResult.source, "--times", "2", "-d"],
        cli,
        started.value,
        setupResult.env,
        { repository: setupResult.repo, pollMs: 10 },
      ),
      0,
      started.errors(),
    );
    let output = "";
    let errors = "";
    const code = await tailCommand(
      ["tail", started.output().trim()],
      (text) => {
        output += text;
      },
      (text) => {
        errors += text;
      },
      setupResult.env,
      { pollIntervalMs: 10, ownerPingTimeoutMs: 1_000 },
    );

    assert.equal(code, 0, errors);
    const lines = output.trimEnd().split("\n");
    assert.equal(lines.filter((line) => /step started$/.test(line)).length, 2);
    assert.equal(lines.filter((line) => /step ended clean exit$/.test(line)).length, 2);
    assert.equal(lines.filter((line) => /^loop: run \d+ \S+ started$/.test(line)).length, 2);
    assert.equal(lines.filter((line) => /loop: run \d+ \S+ completed/.test(line)).length, 2);
    assert.match(lines.at(-1) ?? "", /^loop: ended completed source_empty$/);
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("tail prints the full history of an ended times loop", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 0.05\n",
  );
  try {
    const started = io();
    assert.equal(
      await loopCommand(
        ["loop", setupResult.source, "--times", "2", "-d"],
        cli,
        started.value,
        setupResult.env,
        { repository: setupResult.repo, pollMs: 10 },
      ),
      0,
      started.errors(),
    );
    const loopId = started.output().trim();
    const history = await waitForEnd(setupResult.home, loopId);
    const runs = history.filter(
      (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
        event.type === "loop.run_started",
    );

    let output = "";
    let errors = "";
    const code = await tailCommand(
      ["tail", loopId],
      (text) => {
        output += text;
      },
      (text) => {
        errors += text;
      },
      setupResult.env,
      { pollIntervalMs: 10, ownerPingTimeoutMs: 1_000 },
    );

    assert.equal(code, 0, errors);
    const lines = output.trimEnd().split("\n");
    assert.equal(lines.filter((line) => /step started$/.test(line)).length, 2);
    assert.equal(lines.filter((line) => /step ended clean exit$/.test(line)).length, 2);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("loop: ")),
      [
        ...runs.flatMap((run) => [
          `loop: run ${run.index} ${run.runId} started`,
          `loop: run ${run.index} ${run.runId} completed`,
        ]),
        "loop: ended completed source_empty",
      ],
    );
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("tail returns 2 when a loop owner is gone", async () => {
  const setupResult = await setup();
  const loopId = "loop-20260917-160344-k3f7";
  try {
    const paths = loopPaths(setupResult.home, loopId);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.events, '{"type":"loop.created","seq":1,"at":"x"}\n');

    const output = io();
    const code = await tailCommand(
      ["tail", loopId],
      output.value.out,
      output.value.err,
      setupResult.env,
      { pollIntervalMs: 10, ownerPingTimeoutMs: 1_000 },
    );

    assert.equal(code, 2);
    assert.match(output.errors(), /code: owner_gone/);
    assert.match(output.errors(), /loop owner/);
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("tail --json includes loop and child events", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 0.05\n",
  );
  try {
    const started = io();
    assert.equal(
      await loopCommand(
        ["loop", setupResult.source, "--times", "2", "-d"],
        cli,
        started.value,
        setupResult.env,
        { repository: setupResult.repo, pollMs: 10 },
      ),
      0,
      started.errors(),
    );
    let output = "";
    const code = await tailCommand(
      ["tail", started.output().trim(), "--json"],
      (text) => {
        output += text;
      },
      () => undefined,
      setupResult.env,
      { pollIntervalMs: 10, ownerPingTimeoutMs: 1_000 },
    );

    assert.equal(code, 0);
    const events = output
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string });
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 2);
    assert.equal(events.filter((event) => event.type === "run.created").length, 2);
    assert.equal(events.filter((event) => event.type === "run.ended").length, 2);
    assert.equal(events.at(-1)?.type, "loop.ended");
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("tail returns 1 for a failed loop", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: exit 1\n",
  );
  try {
    const started = io();
    assert.equal(
      await loopCommand(
        ["loop", setupResult.source, "--times", "2", "-d"],
        cli,
        started.value,
        setupResult.env,
        { repository: setupResult.repo, pollMs: 10 },
      ),
      0,
      started.errors(),
    );
    let output = "";
    const code = await tailCommand(
      ["tail", started.output().trim()],
      (text) => {
        output += text;
      },
      () => undefined,
      setupResult.env,
      { pollIntervalMs: 10, ownerPingTimeoutMs: 1_000 },
    );

    assert.equal(code, 1);
    assert.match(output, /loop: ended failed run_failed/);
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("an attached loop reports a failed child as an operator failure", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: exit 1\n",
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 1);
    const loopId = captured.output().trim();
    const lines = captured.errors().trim().split("\n");
    assert.equal(lines[0], `started: ${loopId}`);
    assert.match(lines[1] ?? "", /^run: 1 \S+ started$/);
    assert.match(lines[2] ?? "", /^run: 1 \S+ failed$/);
    assert.match(lines[3] ?? "", /^error: loop loop-\S+ failed: run_failed \(run \S+ failed\)$/);
    assert.equal(lines[4], "code: operation_failed");
    assert.equal(lines[5], `help: See each run with: loopfile result ${loopId}`);
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("SIGINT detaches from an attached loop without stopping its owner", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 1\n",
  );
  let loopId: string | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, [cli, "loop", setupResult.source, "--times", "2"], {
      cwd: setupResult.repo,
      env: setupResult.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    const stderr = child.stderr;
    assert.ok(stderr);
    stderr.setEncoding("utf8");
    const started = new Promise<string>((resolve, reject) => {
      stderr.on("data", (text: string) => {
        errors += text;
        const line = errors.match(/^started: ([^\n]+)$/m);
        if (line?.[1] !== undefined) resolve(line[1]);
      });
      child?.once("error", reject);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child?.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    loopId = await started;
    assert.equal(child.kill("SIGINT"), true);
    const result = await exited;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(await pingOwner(loopPaths(setupResult.home, loopId).socket, 200), loopId);
    await waitForEnd(setupResult.home, loopId);
  } finally {
    child?.kill("SIGKILL");
    if (loopId !== undefined) await waitForEnd(setupResult.home, loopId).catch(() => undefined);
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("an attached loop reports a gone loop owner without ending the loop", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: sleep 0.2\n",
  );
  let kill: Promise<void> | undefined;
  try {
    const captured = io((text) => {
      if (text.startsWith("started: ")) {
        const loopId = text.slice("started: ".length).trim();
        kill = killLoopOwner(setupResult.home, loopId);
      }
    });
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 2);
    await kill;
    assert.match(captured.errors(), /code: owner_gone/);
    assert.match(captured.errors(), /help: Resume the crashed loop with: loopfile resume loop-/);
  } finally {
    await kill?.catch(() => undefined);
    await removeAfterOwnersExit(setupResult.root);
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
        args: ["--max-runs", "0", "--times", "2", "-d"],
        message: "--max-runs must be an integer of 1 or more",
      },
      {
        args: ["--max-runs=-1", "--times", "2", "-d"],
        message: "--max-runs must be an integer of 1 or more",
      },
      {
        args: ["--max-runs", "nope", "--times", "2", "-d"],
        message: "--max-runs must be an integer of 1 or more",
      },
      {
        args: ["--pause", "nope", "--times", "2", "-d"],
        message: "--pause must be a positive duration with the unit s, m or h, such as 30m",
      },
      {
        args: ["--retry=-1", "--times", "2", "-d"],
        message: "--retry must be an integer of 0 or more",
      },
      {
        args: ["--retry", "nope", "--times", "2", "-d"],
        message: "--retry must be an integer of 0 or more",
      },
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
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("an attached loop stops at max-runs and exits successfully", async () => {
  const setupResult = await setup(
    "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: 'true'\n",
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "5", "--max-runs", "2"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 0, captured.errors());
    const loopId = captured.output().trim();
    const events = await waitForEnd(setupResult.home, loopId);
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 2);
    assert.equal(events[0]?.type === "loop.created" ? events[0].maxRuns : undefined, 2);
    assert.equal(loopStatus(events).state, "completed");
    assert.equal(loopStatus(events).endReason, "max_runs");
    assert.match(captured.errors(), new RegExp(`ended: ${loopId} completed max_runs`));
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("max runs caps a retry", async () => {
  const setupResult = await setup();
  const counter = join(setupResult.root, "retry-count");
  await writeFile(
    join(setupResult.source, "manifest.yaml"),
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: ${JSON.stringify(`test -e ${counter} || (touch ${counter} && exit 1)`)}\n`,
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "1", "--retry", "1", "--max-runs", "1"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 0, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 1);
    assert.equal(loopStatus(events).endReason, "max_runs");
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("retries a failed run in a new workspace and completes", async () => {
  const setupResult = await setup();
  const state = join(setupResult.root, "outside-workspace-state");
  await writeFile(
    join(setupResult.source, "manifest.yaml"),
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: ${JSON.stringify(`test -e ${state} || (touch ${state} && exit 1)`)}\n`,
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "1", "--retry", "1"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 0, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    const started = events.filter(
      (event): event is Extract<LoopEvent, { type: "loop.run_started" }> =>
        event.type === "loop.run_started",
    );
    assert.equal(events[0]?.type === "loop.created" ? events[0].retry : undefined, 1);
    assert.equal(started.length, 2);
    assert.equal(started[1]?.retryOf, started[0]?.runId);
    assert.deepEqual(
      { inputSet: started[1]?.inputSet, sourceIndex: started[1]?.sourceIndex },
      { inputSet: started[0]?.inputSet, sourceIndex: started[0]?.sourceIndex },
    );
    assert.equal(loopStatus(events).state, "completed");
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("retry zero fails after one run", async () => {
  const setupResult = await setup();
  const state = join(setupResult.root, "outside-workspace-state");
  await writeFile(
    join(setupResult.source, "manifest.yaml"),
    `formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: ${JSON.stringify(`test -e ${state} || (touch ${state} && exit 1)`)}\n`,
  );
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "1", "--retry", "0"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 1, captured.errors());
    const events = await waitForEnd(setupResult.home, captured.output().trim());
    assert.equal(events.filter((event) => event.type === "loop.run_started").length, 1);
    assert.equal(loopStatus(events).endReason, "run_failed");
  } finally {
    await removeAfterOwnersExit(setupResult.root);
  }
});

test("an attached loop reports each run and its successful end", async () => {
  const setupResult = await setup();
  try {
    const captured = io();
    const code = await loopCommand(
      ["loop", setupResult.source, "--times", "2"],
      cli,
      captured.value,
      setupResult.env,
      { repository: setupResult.repo, pollMs: 10, ownerPingTimeoutMs: LIVE_PING_MS },
    );
    assert.equal(code, 0, captured.errors());
    const loopId = captured.output().trim();
    const lines = captured.errors().trim().split("\n");
    assert.equal(lines[0], `started: ${loopId}`);
    assert.match(lines[1] ?? "", /^run: 1 \S+ started$/);
    assert.match(lines[2] ?? "", /^run: 1 \S+ completed$/);
    assert.match(lines[3] ?? "", /^run: 2 \S+ started$/);
    assert.match(lines[4] ?? "", /^run: 2 \S+ completed$/);
    assert.equal(lines[5], `ended: ${loopId} completed source_empty`);
    assert.equal(lines.length, 6);
  } finally {
    await removeAfterOwnersExit(setupResult.root);
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
    await removeAfterOwnersExit(setupResult.root);
  }
});

/** A child run's `status.json` in `state`. */
function childStatus(runId: string, state: "running" | "failed"): string {
  const ended = state === "failed";
  return JSON.stringify({
    formatVersion: 1,
    seq: 1,
    updatedAt: "2026-09-22T10:00:00.000Z",
    runId,
    loopfileName: "source",
    loopId: null,
    loopIndex: null,
    state,
    endReason: ended ? "failure" : null,
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: ended ? "2026-09-22T10:00:01.000Z" : null,
    current: null,
    lastActivityAt: "2026-09-22T10:00:00.000Z",
    lastProgress: null,
    visitedSteps: [],
    lastTransition: null,
    transitions: 0,
    maxTransitions: null,
    metrics: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: null,
    },
  });
}

test("a child run that ends while the ping waits is failed, not crashed", async () => {
  const setupResult = await setup();
  const runId = "20260922-100000-abcd";
  const paths = runPaths(setupResult.home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, childStatus(runId, "running"));
  // An owner that ends while it is pinged: it never answers, writes its final
  // status, then closes the connection, as a real owner closes its socket last.
  const owner: Server = createServer(async (socket) => {
    await writeFile(`${paths.status}.tmp`, childStatus(runId, "failed"));
    await rename(`${paths.status}.tmp`, paths.status);
    socket.destroy();
  });
  await new Promise<void>((resolve) => owner.listen(paths.socket, () => resolve()));
  try {
    assert.equal(await childEndState(setupResult.home, runId, false, 30_000), "failed");
  } finally {
    await new Promise((resolve) => owner.close(resolve));
    await removeAfterOwnersExit(setupResult.root);
  }
});
