import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import { type LaunchIo, launchCommand, startRun } from "./launch-command.ts";
import { listCommand } from "./list-command.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { writeArchive } from "./pack-command.ts";
import { makeGitFixture } from "./remote-fixture.ts";
import { resultCommand } from "./result-command.ts";
import { runPaths } from "./run-directory.ts";
import { statusCommand } from "./status-command.ts";
import { tailCommand } from "./tail-command.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-launch-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

/** The step reads `input.issue` with the step command, and fails unless it is 42. */
const MANIFEST = `formatVersion: 1
inputs:
  issue: The issue number
steps:
  - id: read
    kind: command
    run: test "$(node ${cli} data get input.issue)" = 42
`;

async function setup(manifest = MANIFEST) {
  count += 1;
  const base = join(root, `case-${count}`);
  const repo = join(base, "repo");
  const source = join(base, "source");
  const home = join(base, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await run("git", ["commit", "-q", "-m", "first"], {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
  });
  await writeFile(join(source, "manifest.yaml"), manifest);
  const env = { ...process.env, ...gitEnv, LOOPFILE_HOME: home };
  return { base, repo, source, home, env };
}

function terminal(tty: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return { io: { input, output } as MonitorIo, input, text: () => written };
}

function session(tty = false) {
  let out = "";
  let err = "";
  const screen = terminal(tty);
  const io: LaunchIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    upgrade: {
      out: () => undefined,
      err: (text) => {
        err += text;
      },
      isTTY: false,
      ask: async () => null,
    },
    monitor: screen.io,
  };
  return { io, screen, out: () => out, err: () => err };
}

/**
 * A temp folder of the test's own for a remote fetch, so a check that the
 * fetch cleaned up never sees another test's `loopfile-remote-` folder.
 */
async function privateTmp(base: string): Promise<string> {
  const tmp = join(base, "tmp");
  await mkdir(tmp);
  return tmp;
}

async function remoteFolders(tmp: string): Promise<readonly string[]> {
  return (await readdir(tmp)).filter((name) => name.startsWith("loopfile-remote-"));
}

function resultOf(events: ReturnType<typeof parseEventLog>): string | undefined {
  const last = events.at(-1);
  return last?.type === "run.ended" ? last.result : undefined;
}

async function waitForEnd(home: string, runId: string): Promise<ReturnType<typeof parseEventLog>> {
  const paths = runPaths(home, runId);
  for (let tries = 0; tries < 400; tries += 1) {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    if (events.some((event) => event.type === "run.ended")) return events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the run did not end");
}

async function detached(source: string, home: string, env: NodeJS.ProcessEnv, repo: string) {
  const s = session();
  const code = await launchCommand([source, "-d", "--input", "issue=42"], cli, s.io, env, {
    repository: repo,
  });
  assert.equal(code, 0, s.err());
  const runId = s.out().trim();
  assert.match(runId, /^\d{8}-\d{6}-/);
  const events = await waitForEnd(home, runId);
  return { runId, events, paths: runPaths(home, runId) };
}

test("a trusted GitHub Remote Loopfile runs and uses the repository name", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture({
    "manifest.yaml": "formatVersion: 1\nsteps:\n  - id: done\n    kind: command\n    run: 'true'\n",
  });
  const tmp = await privateTmp(base);
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:Acme/Loops", "--trust", "-d"],
        cli,
        s.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    assert.deepEqual(await remoteFolders(tmp), []);
    const runId = s.out().trim();
    assert.equal(resultOf(await waitForEnd(home, runId)), "success");
    const status = JSON.parse(await readFile(runPaths(home, runId).status, "utf8")) as {
      loopfileName: string;
    };
    assert.equal(status.loopfileName, "loops");
  } finally {
    await fixture.cleanup();
  }
});

test("--trust does not change a local launch", async () => {
  const { repo, source, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand([source, "--trust", "-d", "--input", "issue=42"], cli, s.io, env, {
      repository: repo,
    }),
    0,
    s.err(),
  );
  assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
});

test("an untrusted GitHub Remote Loopfile refuses without making a run", async () => {
  const { repo, home, env } = await setup();
  const fixture = await makeGitFixture({
    "manifest.yaml": "formatVersion: 1\nsteps:\n  - id: done\n    kind: command\n    run: 'true'\n",
  });
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops"],
        cli,
        s.io,
        { ...env, ...fixture.env },
        { repository: repo },
      ),
      2,
    );
    assert.match(s.err(), /error: untrusted Remote Loopfile github\.com\/acme\/loops/);
    assert.match(s.err(), /code: untrusted/);
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("a remote manifest failure cleans its fetched folder", async () => {
  const { base, repo, home, env } = await setup("formatVersion: 1\nsteps: []\n");
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  const tmp = await privateTmp(base);
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "--trust"],
        cli,
        s.io,
        { ...env, ...fixture.env, TMPDIR: tmp },
        { repository: repo },
      ),
      1,
    );
    assert.deepEqual(await remoteFolders(tmp), []);
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("a remote git failure reports operation_failed and git stderr", async () => {
  const { repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/missing", "--trust"],
        cli,
        s.io,
        { ...env, ...fixture.env },
        { repository: repo },
      ),
      2,
    );
    assert.match(s.err(), /error: "fatal: .*acme\/missing.*does not appear to be a git repository/);
    assert.match(s.err(), /code: operation_failed/);
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("a Materialized Loopfile can start a run with a chosen ID", async () => {
  const { repo, source, home, env } = await setup();
  const runId = "20260922-180000-from-code";
  const started = await startRun({
    source,
    repository: repo,
    inputs: { issue: "42" },
    runId,
    loopId: "loop-20260922-180000-parent",
    loopIndex: 1,
    cli,
    env,
  });
  assert.deepEqual(started, { ok: true, runId });
  const events = await waitForEnd(home, runId);
  assert.equal(resultOf(events), "success");
  const created = events[0];
  assert.deepEqual(
    created?.type === "run.created"
      ? { loopId: created.loopId, loopIndex: created.loopIndex }
      : undefined,
    { loopId: "loop-20260922-180000-parent", loopIndex: 1 },
  );
  assert.ok(await stat(runPaths(home, runId).root));
});

test("a run started from code rejects bad inputs before making its run folder", async () => {
  const { repo, source, home, env } = await setup();
  const started = await startRun({
    source,
    repository: repo,
    inputs: {},
    runId: "20260922-180000-bad-input",
    cli,
    env,
  });
  assert.equal(started.ok, false);
  if (!started.ok) {
    assert.deepEqual(started.failure.messages, ["missing --input issue: The issue number"]);
    assert.equal(started.failure.code, "bad_argument");
  }
  await assert.rejects(stat(join(home, "runs")));
});

test("a thin manifest from stdin starts a run and materializes the manifest", async () => {
  const { repo, home, env } = await setup();
  const s = session();
  const code = await launchCommand(["-", "-d", "--input", "issue=42"], cli, s.io, env, {
    repository: repo,
    readStdin: async () => Buffer.from(MANIFEST),
  });
  assert.equal(code, 0, s.err());
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  assert.equal(resultOf(await waitForEnd(home, runId)), "success");
  assert.equal(await readFile(join(paths.loopfile, "manifest.yaml"), "utf8"), MANIFEST);
});

test("an outdated manifest from stdin is rejected without an uncaught error", async () => {
  const { repo, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand(["-"], cli, s.io, env, {
      repository: repo,
      readStdin: async () => Buffer.from("formatVersion: 0\nsteps: []\n"),
    }),
    1,
  );
  assert.match(s.err(), /missing upgrade step from format version 0/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a directory, a thin .loop and a packed .loop run the same and give input.issue to the first step", async () => {
  const { base, repo, source, home, env } = await setup();
  const thin = join(base, "thin.loop");
  await writeFile(thin, MANIFEST);
  const packed = join(base, "packed.loop");
  await writeArchive(source, packed);

  const shapes: string[][] = [];
  for (const input of [source, thin, packed]) {
    const { events, paths } = await detached(input, home, env, repo);
    assert.equal(resultOf(events), "success", input);
    shapes.push(events.map((event) => event.type));
    // The value is text, read by the step, and never appears in the event log.
    const created = events[0];
    assert.equal(created?.type, "run.created");
    assert.deepEqual(
      created?.type === "run.created" && created.inputs.map(({ name, size }) => [name, size]),
      [["issue", 2]],
    );
    assert.equal(await readFile(join(paths.inputs, "issue"), "utf8"), "42");
    assert.doesNotMatch(await readFile(paths.events, "utf8"), /"42"/);
  }
  assert.deepEqual(shapes[1], shapes[0]);
  assert.deepEqual(shapes[2], shapes[0]);
});

test("a validation error stops before any run folder is made", async () => {
  const { repo, source, home, env } = await setup("formatVersion: 1\nsteps: []\n");
  const s = session();
  const code = await launchCommand([source], cli, s.io, env, { repository: repo });
  assert.equal(code, 1);
  assert.match(s.err(), /steps/);
  await assert.rejects(stat(join(home, "runs")));
});

test("an outdated manifest stops at the upgrade check before any run folder is made", async () => {
  const { repo, source, home, env } = await setup("formatVersion: 0\nsteps: []\n");
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 1);
  assert.match(s.err(), /missing upgrade step from format version 0/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch refusal prints one error line per manifest problem with its location", async () => {
  const { repo, source, home, env } = await setup(`formatVersion: 1
name: invalid
maxTransitions: 0
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 1);
  assert.deepEqual(
    s
      .err()
      .split("\n")
      .filter((line) => line.startsWith("error: ")),
    [
      "error: line 2: name: unknown field `name`",
      "error: line 3: maxTransitions: maxTransitions must be an integer of 1 or more",
    ],
  );
  assert.match(s.err(), /\ncode: invalid_manifest\n/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a bad --input is refused before launch", async () => {
  const { repo, source, home, env } = await setup();
  const cases: [string[], RegExp][] = [
    [["--input", "issue"], /<name>=<value>/],
    [["--input", "Issue=1"], /must match/],
    [["--input", "issue=1", "--input", "issue=2"], /more than once/],
  ];
  for (const [flags, message] of cases) {
    const s = session();
    const code = await launchCommand([source, ...flags], cli, s.io, env, { repository: repo });
    assert.equal(code, 2, flags.join(" "));
    assert.match(s.err(), message);
  }
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch reports each missing input on its own error line", async () => {
  const { repo, source, home, env } = await setup(`formatVersion: 1
inputs:
  issue: the issue number
  task: the issue number, title and body
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 2);
  assert.equal(
    s.err(),
    "error: missing --input issue: the issue number\n" +
      "error: missing --input task: the issue number, title and body\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>.\n",
  );
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch input failure names optional inputs and their defaults", async () => {
  const { repo, source, home, env } = await setup(`formatVersion: 1
inputs:
  issue: the issue number
  merge:
    description: whether to merge
    default: "no"
  ci:
    description: whether CI is required
    default: "yes"
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 2);
  assert.equal(
    s.err(),
    "error: missing --input issue: the issue number\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>. Optional inputs: merge (default: no), ci (default: yes)\n",
  );
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch reports each undeclared input on its own error line", async () => {
  const { repo, source, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand([source, "--input", "other=1", "--input", "another=2"], cli, s.io, env, {
      repository: repo,
    }),
    2,
  );
  assert.equal(
    s.err(),
    "error: --input other is not declared by the Loopfile. Declared inputs: issue.\n" +
      "error: --input another is not declared by the Loopfile. Declared inputs: issue.\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>.\n",
  );
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch stores an omitted default as an input, and a given value wins", async () => {
  const manifest = `formatVersion: 1
inputs:
  issue: The issue number
  merge:
    description: Whether to merge
    default: "no"
steps:
  - id: work
    kind: command
    run: 'test -n "$(node ${cli} data get input.merge)"'
`;
  for (const [extra, expected, size] of [
    [[], "no", 2],
    [["--input", "merge=yes"], "yes", 3],
  ] as const) {
    const { repo, source, home, env } = await setup(manifest);
    const s = session();
    assert.equal(
      await launchCommand([source, "-d", "--input", "issue=42", ...extra], cli, s.io, env, {
        repository: repo,
      }),
      0,
      s.err(),
    );
    const runId = s.out().trim();
    const events = await waitForEnd(home, runId);
    assert.equal(resultOf(events), "success");
    const paths = runPaths(home, runId);
    assert.equal(await readFile(join(paths.inputs, "merge"), "utf8"), expected);
    const created = events[0];
    assert.deepEqual(
      created?.type === "run.created" &&
        created.inputs.map(({ name, size: bytes }) => [name, bytes]),
      [
        ["issue", 2],
        ["merge", size],
      ],
    );
  }
});

test("no source, two sources and a missing path are refused", async () => {
  const { repo, home, env } = await setup();
  const opts = { repository: repo };
  const none = session();
  assert.equal(await launchCommand(["-d"], cli, none.io, env, opts), 2);
  assert.match(none.err(), /Usage: loopfile/);
  const two = session();
  assert.equal(await launchCommand(["a", "b"], cli, two.io, env, opts), 2);
  const bad = session();
  assert.equal(await launchCommand(["--nope", "a"], cli, bad.io, env, opts), 2);
  const missing = session();
  assert.equal(await launchCommand([join(home, "nope")], cli, missing.io, env, opts), 2);
  assert.match(missing.err(), /unknown command '.*nope'/);
});

test("a source that is neither a directory nor text is an input error, not an unknown command", async () => {
  const { base, repo, env } = await setup();
  const empty = join(base, "empty.loop");
  await writeFile(empty, "");
  const s = session();
  assert.equal(await launchCommand([empty], cli, s.io, env, { repository: repo }), 1);
  assert.match(s.err(), /file is empty/);
});

test("a run owner that exits before ready exits 2 and gives the end of owner.log", async () => {
  const { base, source, home, env } = await setup();
  const notARepository = join(base, "plain");
  await mkdir(notARepository);
  const s = session();
  const code = await launchCommand([source, "-d", "--input", "issue=1"], cli, s.io, env, {
    repository: notARepository,
  });
  assert.equal(code, 2);
  assert.equal(s.out(), "");
  assert.match(s.err(), /exited before it was ready/);
  assert.match(s.err(), /owner\.log/);
  const [runId] = await readdir(join(home, "runs"));
  assert.match(await readFile(runPaths(home, runId as string).ownerLog, "utf8"), /loopfile:/);
});

test("a run folder that cannot be made stops the launch", async () => {
  const { repo, source, home, env } = await setup();
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "runs"), "a file, not a folder");
  const s = session();
  assert.equal(
    await launchCommand([source, "-d", "--input", "issue=1"], cli, s.io, env, { repository: repo }),
    1,
  );
  assert.match(s.err(), /run folder already exists/);
});

test("a run owner that never says ready is stopped after the wait and exits 2", async () => {
  const { repo, source, env } = await setup();
  const s = session();
  const code = await launchCommand([source, "-d", "--input", "issue=1"], cli, s.io, env, {
    repository: repo,
    readyTimeoutMs: 1,
  });
  assert.equal(code, 2);
  assert.match(s.err(), /did not say ready in time/);
});

test("without -d the monitor attaches, and d leaves the run running to its end", async () => {
  const { repo, source, home, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: slow\n    kind: command\n    run: sleep 1\n",
  );
  const s = session(true);
  const launched = launchCommand([source], cli, s.io, env, {
    repository: repo,
    monitor: { pollIntervalMs: 50 },
  });
  // Press d only once the monitor has drawn. A fixed wait lost the race on a
  // loaded machine, and the key reached no monitor.
  for (let tries = 0; tries < 200 && !/d detach/.test(s.screen.text()); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  s.screen.input.write("d");
  assert.equal(await launched, 0);
  assert.match(s.screen.text(), /d detach/);
  const [runId] = await readdir(join(home, "runs"));
  const events = await waitForEnd(home, runId as string);
  assert.equal(resultOf(events), "success");
});

test("without a terminal the launch prints the run ID, waits for the end and exits 0 when it completed", async () => {
  const { repo, source, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: quick\n    kind: command\n    run: 'true'\n",
  );
  const s = session(false);
  const code = await launchCommand([source], cli, s.io, env, {
    repository: repo,
    monitor: { pollIntervalMs: 50 },
  });
  assert.equal(code, 0, s.err());
  const [runId, ...rest] = s.out().split("\n");
  assert.match(runId as string, /^\d{8}-\d{6}-/);
  assert.deepEqual(rest, [""]);
  assert.match(s.err(), new RegExp(`started: ${runId}\\n`));
  assert.match(s.err(), new RegExp(`ended: ${runId} completed\\n`));
  assert.equal(s.screen.text(), "");
});

test("without a terminal a failed run exits 1 and says on stderr where to look", async () => {
  const { repo, source, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: quick\n    kind: command\n    run: 'false'\n",
  );
  const s = session(false);
  const code = await launchCommand([source], cli, s.io, env, {
    repository: repo,
    monitor: { pollIntervalMs: 50 },
  });
  assert.equal(code, 1);
  const runId = s.out().split("\n")[0] as string;
  assert.equal(s.out(), `${runId}\n`);
  assert.match(s.err(), new RegExp(`^started: ${runId}\\n`));
  assert.match(s.err(), /error: ["']?run .* failed: /);
  assert.match(s.err(), /\ncode: operation_failed\n/);
  assert.match(s.err(), new RegExp(`loopfile logs ${runId}`));
  assert.match(s.err(), new RegExp(`loopfile status ${runId} --json`));
});

test("the run owner has its own session, so closing the terminal does not reach it", async () => {
  const { repo, source, home, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: slow\n    kind: command\n    run: sleep 2\n",
  );
  const s = session();
  assert.equal(await launchCommand([source, "-d"], cli, s.io, env, { repository: repo }), 0);
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  const started = parseEventLog(await readFile(paths.events, "utf8")).find(
    (event) => event.type === "owner.started",
  );
  const pid = started?.type === "owner.started" ? started.pid : 0;
  assert.ok(pid > 0);
  const sid = async (id: number) =>
    (await run("ps", ["-o", "sid=", "-p", String(id)])).stdout.trim();
  // A session leader: its session ID is its own pid, and not ours.
  assert.equal(await sid(pid), String(pid));
  assert.notEqual(await sid(process.pid), String(pid));
  await waitForEnd(home, runId);
});

test("an in-process launch records its loop link in the event, status and result", async () => {
  const { repo, source, home, env } = await setup();
  const capture = () => {
    let text = "";
    return {
      write: (chunk: string) => {
        text += chunk;
      },
      text: () => text,
    };
  };
  const s = session();
  assert.equal(
    await launchCommand([source, "-d", "--input", "issue=42"], cli, s.io, env, {
      repository: repo,
      loopId: "loop-20260922-105306-qfn3",
      loopIndex: 3,
    }),
    0,
    s.err(),
  );
  const runId = s.out().trim();
  const events = await waitForEnd(home, runId);
  const created = events[0];
  assert.deepEqual(
    created?.type === "run.created"
      ? { loopId: created.loopId, loopIndex: created.loopIndex }
      : undefined,
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );

  const paths = runPaths(home, runId);
  const statusFile = JSON.parse(await readFile(paths.status, "utf8")) as {
    loopId: string;
    loopIndex: number;
  };
  assert.deepEqual(
    { loopId: statusFile.loopId, loopIndex: statusFile.loopIndex },
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );

  const status = capture();
  assert.equal(await statusCommand(["status", runId], status.write, capture().write, env), 0);
  assert.match(status.text(), /^loop: loop-20260922-105306-qfn3 \(run 3\)$/m);
  const statusJson = capture();
  assert.equal(
    await statusCommand(["status", runId, "--json"], statusJson.write, capture().write, env),
    0,
  );
  const statusBody = JSON.parse(statusJson.text()) as { loopId: string; loopIndex: number };
  assert.deepEqual(
    { loopId: statusBody.loopId, loopIndex: statusBody.loopIndex },
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );

  const result = capture();
  assert.equal(await resultCommand(["result", runId], result.write, result.write, env), 0);
  assert.match(result.text(), /^loop: loop-20260922-105306-qfn3 \(run 3\)$/m);
  const resultJson = capture();
  assert.equal(
    await resultCommand(["result", runId, "--json"], resultJson.write, resultJson.write, env),
    0,
  );
  const resultBody = JSON.parse(resultJson.text()) as { loopId: string; loopIndex: number };
  assert.deepEqual(
    { loopId: resultBody.loopId, loopIndex: resultBody.loopIndex },
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );
});

test("the printed run ID is found by status, tail and list", async () => {
  const { repo, source, home, env } = await setup();
  const { runId } = await detached(source, home, env, repo);
  const capture = () => {
    let text = "";
    return {
      write: (chunk: string) => {
        text += chunk;
      },
      text: () => text,
    };
  };

  const status = capture();
  const statusErr = capture();
  assert.equal(await statusCommand(["status", runId], status.write, statusErr.write, env), 0);
  assert.match(status.text(), new RegExp(runId));
  assert.doesNotMatch(status.text(), /^loop:/m);

  const statusJson = capture();
  assert.equal(
    await statusCommand(["status", runId, "--json"], statusJson.write, statusErr.write, env),
    0,
  );
  const plainStatus = JSON.parse(statusJson.text()) as {
    loopId: string | null;
    loopIndex: number | null;
  };
  assert.deepEqual(
    { loopId: plainStatus.loopId, loopIndex: plainStatus.loopIndex },
    { loopId: null, loopIndex: null },
  );
  const result = capture();
  const resultErr = capture();
  assert.equal(await resultCommand(["result", runId], result.write, resultErr.write, env), 0);
  assert.doesNotMatch(result.text(), /^loop:/m);
  const resultJson = capture();
  assert.equal(
    await resultCommand(["result", runId, "--json"], resultJson.write, resultErr.write, env),
    0,
  );
  const plainResult = JSON.parse(resultJson.text()) as {
    loopId: string | null;
    loopIndex: number | null;
  };
  assert.deepEqual(
    { loopId: plainResult.loopId, loopIndex: plainResult.loopIndex },
    { loopId: null, loopIndex: null },
  );

  const tail = capture();
  const tailErr = capture();
  assert.equal(
    await tailCommand(["tail", runId], tail.write, tailErr.write, env),
    0,
    tailErr.text(),
  );
  assert.notEqual(tail.text(), "");

  const list = capture();
  assert.equal(await listCommand(["list", "--json"], list.write, capture().write, env), 0);
  assert.match(list.text(), new RegExp(runId));
});
