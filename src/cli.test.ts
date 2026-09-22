import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAttemptDirectory } from "./adapters/attempt-directory.ts";
import { dataGetHandler } from "./adapters/data-get-handler.ts";
import { dataPutHandler } from "./adapters/data-put-handler.ts";
import { put } from "./adapters/data-store.ts";
import { resultHandler } from "./adapters/result-handler.ts";
import { runPaths } from "./adapters/run-directory.ts";
import { startRunOwner } from "./adapters/run-owner.ts";
import { parseEventLog } from "./application/replay.ts";
import { main } from "./cli.ts";

const ATTEMPT = { LOOPFILE_ENDPOINT: "/run/007/owner.sock" };

/**
 * Runs the CLI and captures what it wrote.
 *
 * `output` and `errors` are getters, not plain fields: `code` can be a
 * promise, and a caller that destructures before awaiting it would otherwise
 * copy out today's empty string instead of reading what the command wrote.
 */
function run(
  argv: string[],
  env: Record<string, string | undefined> = {},
  readStdin?: () => Promise<Buffer>,
) {
  let output = "";
  let errors = "";
  const code = main(
    argv,
    (text) => {
      output += typeof text === "string" ? text : Buffer.from(text).toString();
    },
    (text) => {
      errors += text;
    },
    env,
    readStdin,
  );
  return {
    code,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}

test("run through a symlink, as npm installs it, the CLI still runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loopfile-bin-"));
  try {
    const link = join(dir, "loopfile");
    await symlink(fileURLToPath(new URL("./cli.ts", import.meta.url)), link);
    assert.match(execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" }), /Usage:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--help is a short command index", () => {
  const { code, output } = run(["--help"]);
  assert.equal(code, 0);
  assert.match(output, /^loopfile /);
  assert.match(output, /Usage:/);
  assert.match(output.split("\n").slice(0, 10).join("\n"), /loopfile docs manifest/);
  assert.deepEqual(
    output
      .slice(output.indexOf("Commands:") + "Commands:\n".length, output.indexOf("Options:"))
      .trimEnd()
      .split("\n"),
    [
      "  pack <directory> [-o <path>] [--force]",
      "  check <source> [--json]",
      "  docs [<topic>]",
      "  list [--json]",
      "  cancel <runid>",
      "  resume [<runid>] [-d] [--kill-leftovers]",
      "  remove <runid> [--kill-leftovers] [--force]",
      "  prune [--older-than <age>] [--dry-run]",
      "  logs <runid> [<attempt>] [--stdout | --stderr] [--iteration <n>]",
      "  logs <runid> --owner",
      "  status [<runid>] [--monitor | --json]",
      "  tail <runid> [--json]",
      "  result <runid> [--json]",
      "  unpack <file.loop> [<destination>]",
      "  upgrade <source>",
    ],
  );
  assert.doesNotMatch(output, /Run a Loopfile|With no terminal|Exit codes:/);
});

test("every operator command has its own help", async () => {
  const commands = [
    ["./source", "--help"],
    ["pack", "--help"],
    ["check", "--help"],
    ["docs", "--help"],
    ["list", "--help"],
    ["cancel", "--help"],
    ["resume", "--help"],
    ["remove", "--help"],
    ["prune", "--help"],
    ["logs", "--help"],
    ["status", "--help"],
    ["tail", "--help"],
    ["result", "--help"],
    ["unpack", "--help"],
    ["upgrade", "--help"],
  ];

  for (const argv of commands) {
    const result = run(argv);
    assert.equal(await result.code, 0, argv.join(" "));
    assert.match(result.output, /^Usage: loopfile/, argv.join(" "));
    assert.equal(result.errors, "", argv.join(" "));
    if (argv[0] === "./source") {
      assert.match(result.output, /--detach/);
      assert.match(result.output, /live monitor/);
      assert.match(result.output, /With no terminal/);
      assert.match(result.output, /Exit codes are/);
    }
    if (argv[0] === "resume") {
      assert.match(result.output, /live monitor/);
      assert.match(result.output, /terminal and without --detach/);
      assert.match(result.output, /Exit codes are/);
    }
    if (argv[0] === "tail") {
      assert.match(result.output, /follow the run until it ends/);
      assert.match(result.output, /stdout only/);
      assert.match(result.output, /Exit codes are/);
    }
  }
});

test("no arguments prints usage and exits 0", () => {
  assert.equal(run([]).code, 0);
});

test("--version prints a version", () => {
  const { code, output } = run(["--version"]);
  assert.equal(code, 0);
  assert.match(output, /^\d+\.\d+\.\d+/);
});

test("an unknown command that is no path either exits 2", async () => {
  const result = run(["nope"]);
  assert.equal(await result.code, 2);
  assert.match(result.errors, /unknown command 'nope'/);
});

test("an unknown option exits 2", () => {
  assert.equal(run(["--nope"]).code, 2);
});

test("__owner is hidden: it is not in the help a person reads", () => {
  assert.doesNotMatch(run(["--help"]).output, /__owner/);
  assert.doesNotMatch(run([], ATTEMPT).output, /__owner/);
});

test("__owner without a run ID is a run owner error, not an unknown command", async () => {
  const { code, output, errors } = run(["__owner"]);
  assert.equal(await code, 2);
  assert.equal(output, "");
  assert.match(errors, /needs a run ID/);
});

test("outside an attempt the help does not list step commands", () => {
  const { output } = run(["--help"]);
  assert.doesNotMatch(output, /Step commands/);
  assert.doesNotMatch(output, /data get/);
  assert.match(output, /Options:/);
});

test("inside an attempt the help lists step commands next to the same options", () => {
  const { output } = run(["--help"], ATTEMPT);
  assert.match(output, /Step commands/);
  assert.match(output, /data get <key>/);
  assert.match(output, /Options:/);
});

test("the operator result form is selected outside an attempt", async () => {
  const outside = run(["result", "approved"]);
  assert.equal(await outside.code, 2);
  assert.equal(outside.output, "");
  assert.match(outside.errors, /code: no_such_run/);
});

test("step data commands are gated outside an attempt", () => {
  assert.equal(run(["data", "get", "spec.md"]).code, 2);
  assert.match(run(["data", "put", "review.md", "text"]).errors, /code: no_endpoint/);
});

test("a step command's own flags never reach the operator argument table", async () => {
  const outside = run(["result", "changes_requested", "--message", "needs tests"]);
  assert.equal(await outside.code, 2);
  assert.match(outside.errors, /code: bad_argument/);
  assert.equal(outside.output, "");

  const inside = run(["result", "changes_requested", "--message", "needs tests"], ATTEMPT);
  assert.notEqual(await inside.code, 0, "no run owner is listening at ATTEMPT's endpoint");
  assert.equal(inside.output, "", "an operator's `unknown option` is not a step's payload");
  assert.doesNotMatch(inside.errors, /Unknown option/);
});

test("inside an attempt a step command writes nothing to stdout", async () => {
  for (const argv of [
    ["result", "approved"],
    ["data", "get", "spec.md"],
    ["data", "put", "x"],
  ]) {
    const result = run(argv, ATTEMPT);
    const resolvedCode = await result.code;
    assert.equal(result.output, "", `${argv[0]} must leave stdout to the payload`);
    assert.ok(result.errors.length > 0, `${argv[0]} says what happened on stderr`);
    assert.notEqual(resolvedCode, 0);
  }
});

test("`data get` with no endpoint and no key both fail synchronously", () => {
  const noEndpoint = run(["data", "get", "spec.md"]);
  assert.equal(noEndpoint.code, 2);
  assert.match(noEndpoint.errors, /code: no_endpoint/);

  const noKey = run(["data", "get"], ATTEMPT);
  assert.equal(noKey.code, 1);
  assert.match(noKey.errors, /code: missing_arg/);
});

test("`data get` reads a real value through a real run owner and writes raw bytes to stdout", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-data-get-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli1";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-implement");
  const putEvent = await owner.events.append({
    type: "attempt.started",
    attemptId: "001-implement",
    stepId: "implement",
    processGroupId: 1,
  });
  const dataEvent = await put({
    events: owner.events,
    history: [putEvent],
    attemptsFolder: owner.paths.attempts,
    attemptId: "001-implement",
    key: "implement.review",
    content: Buffer.from("please review this"),
  });
  await createAttemptDirectory(owner.paths.attempts, "002-review");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "002-review",
    stepId: "review",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "002-review", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "002-review", secret: "s3cret" }),
    handle: dataGetHandler({
      events: owner.events,
      attemptsFolder: owner.paths.attempts,
      inputsFolder: owner.paths.inputs,
      history: () => [putEvent, dataEvent],
    }),
  });
  t.after(() => endpoint.close());

  const result = run(["data", "get", "implement.review"], {
    LOOPFILE_ENDPOINT: socketPath,
    LOOPFILE_ATTEMPT_ID: "002-review",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  });
  assert.equal(await result.code, 0);
  assert.equal(result.output, "please review this");
  assert.match(result.errors, /^ok: read implement\.review\n/);
  assert.match(result.errors, /attempt: 001-implement/);
  assert.match(result.errors, /bytes: 18/);
});

test("`data put` with no endpoint and missing arguments both fail synchronously", () => {
  const noEndpoint = run(["data", "put", "review.feedback", "./review.md"]);
  assert.equal(noEndpoint.code, 2);
  assert.match(noEndpoint.errors, /code: no_endpoint/);

  const noFile = run(["data", "put", "review.feedback"], ATTEMPT);
  assert.equal(noFile.code, 1);
  assert.match(noFile.errors, /code: missing_arg/);
});

test("`data append` with no endpoint and a missing value both fail synchronously", () => {
  const noEndpoint = run(["data", "append", "review.notes", "looks fine"]);
  assert.equal(noEndpoint.code, 2);
  assert.match(noEndpoint.errors, /code: no_endpoint/);

  const noValue = run(["data", "append", "review.notes"], ATTEMPT);
  assert.equal(noValue.code, 1);
  assert.match(noValue.errors, /code: missing_arg/);
});

test("`data put` reads a file, sends its bytes through a real run owner, and writes nothing to stdout", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-data-put-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli2";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-review");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "001-review",
    stepId: "review",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "001-review", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "001-review", secret: "s3cret" }),
    handle: dataPutHandler({
      events: owner.events,
      attemptsFolder: owner.paths.attempts,
      history: () => parseEventLog(readFileSync(owner.paths.events, "utf8")),
    }),
  });
  t.after(() => endpoint.close());

  const sourceFile = join(scratch, "review.md");
  await writeFile(sourceFile, "please review this");

  const result = run(["data", "put", "review.feedback", sourceFile], {
    LOOPFILE_ENDPOINT: socketPath,
    LOOPFILE_ATTEMPT_ID: "001-review",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  });
  assert.equal(await result.code, 0);
  assert.equal(result.output, "", "a put writes no payload to stdout");
  assert.match(result.errors, /^ok: put review\.feedback\n/);
  assert.match(result.errors, /bytes: 18/);
  assert.match(result.errors, /digest: [0-9a-f]{64}/);

  const onDisk = await readFile(
    join(owner.paths.attempts, "001-review", "data", "review.feedback"),
    "utf8",
  );
  assert.equal(onDisk, "please review this");

  // Changing the source file after the put does not change the stored value.
  await writeFile(sourceFile, "changed my mind");
  const stillOnDisk = await readFile(
    join(owner.paths.attempts, "001-review", "data", "review.feedback"),
    "utf8",
  );
  assert.equal(stillOnDisk, "please review this");
});

test("`data put test.log -` stores stdin", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-data-put-stdin-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli3";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-log");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "001-log",
    stepId: "log",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "001-log", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "001-log", secret: "s3cret" }),
    handle: dataPutHandler({
      events: owner.events,
      attemptsFolder: owner.paths.attempts,
      history: () => parseEventLog(readFileSync(owner.paths.events, "utf8")),
    }),
  });
  t.after(() => endpoint.close());

  const result = run(
    ["data", "put", "log.test", "-"],
    {
      LOOPFILE_ENDPOINT: socketPath,
      LOOPFILE_ATTEMPT_ID: "001-log",
      LOOPFILE_ATTEMPT_SECRET: "s3cret",
    },
    async () => Buffer.from("stdin output"),
  );
  assert.equal(await result.code, 0);
  assert.match(result.errors, /^ok: put log\.test\n/);

  const onDisk = await readFile(join(owner.paths.attempts, "001-log", "data", "log.test"), "utf8");
  assert.equal(onDisk, "stdin output");
});

test("`data put` of a file that does not exist fails clearly, not with a crash", async () => {
  const result = run(["data", "put", "review.feedback", "/no/such/file"], ATTEMPT);
  assert.equal(await result.code, 1);
  assert.match(result.errors, /code: missing_arg/);
});

test("`data append` sends its value through a real run owner and marks the key as appended", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-data-append-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli4";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-review");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "001-review",
    stepId: "review",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "001-review", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "001-review", secret: "s3cret" }),
    handle: dataPutHandler({
      events: owner.events,
      attemptsFolder: owner.paths.attempts,
      history: () => parseEventLog(readFileSync(owner.paths.events, "utf8")),
    }),
  });
  t.after(() => endpoint.close());

  const env = {
    LOOPFILE_ENDPOINT: socketPath,
    LOOPFILE_ATTEMPT_ID: "001-review",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  };
  const result = run(["data", "append", "review.notes", "first note"], env);
  assert.equal(await result.code, 0);
  assert.equal(result.output, "");
  assert.match(result.errors, /^ok: append review\.notes\n/);
  assert.match(result.errors, /bytes: 10/);

  const conflictFile = join(scratch, "unused");
  await writeFile(conflictFile, "irrelevant");
  const conflictResult = run(["data", "put", "review.notes", conflictFile], env);
  assert.equal(await conflictResult.code, 1);
  assert.match(conflictResult.errors, /code: write_kind_mismatch/);
});

test("`result` reports a real outcome through a real run owner", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-result-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli2";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-review");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "001-review",
    stepId: "review",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "001-review", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "001-review", secret: "s3cret" }),
    handle: resultHandler({
      events: owner.events,
      allowedOutcomes: ["approved", "changes_requested"],
      history: () => [],
    }),
  });
  t.after(() => endpoint.close());

  const result = run(["result", "approved", "--message", "looks good"], {
    LOOPFILE_ENDPOINT: socketPath,
    LOOPFILE_ATTEMPT_ID: "001-review",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  });
  assert.equal(await result.code, 0);
  assert.equal(result.output, "");
  assert.match(result.errors, /^ok: reported approved\n/);
});

test("a `--message` over the byte limit still succeeds, with a truncation warning", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-result-msg-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli3";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-review");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "001-review",
    stepId: "review",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "001-review", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "001-review", secret: "s3cret" }),
    handle: resultHandler({
      events: owner.events,
      allowedOutcomes: ["approved"],
      history: () => [],
    }),
  });
  t.after(() => endpoint.close());

  const result = run(["result", "approved", "--message", "x".repeat(600)], {
    LOOPFILE_ENDPOINT: socketPath,
    LOOPFILE_ATTEMPT_ID: "001-review",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  });
  assert.equal(await result.code, 0);
  assert.match(result.errors, /^warning: --message was cut/);
  assert.match(result.errors, /ok: reported approved/);
});

test("an outcome not in `on` fails as fixable, naming the allowed outcomes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "loopfile-cli-result-bad-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const runId = "20260917-160344-cli4";
  await mkdir(runPaths(scratch, runId).root, { recursive: true });
  const owner = await startRunOwner({ home: scratch, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  await createAttemptDirectory(owner.paths.attempts, "001-review");
  await owner.events.append({
    type: "attempt.started",
    attemptId: "001-review",
    stepId: "review",
    processGroupId: 1,
  });

  const socketPath = join(owner.paths.attempts, "001-review", "sock");
  const endpoint = await owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId: "001-review", secret: "s3cret" }),
    handle: resultHandler({
      events: owner.events,
      allowedOutcomes: ["approved"],
      history: () => [],
    }),
  });
  t.after(() => endpoint.close());

  const result = run(["result", "nope"], {
    LOOPFILE_ENDPOINT: socketPath,
    LOOPFILE_ATTEMPT_ID: "001-review",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  });
  assert.equal(await result.code, 1);
  assert.match(result.errors, /code: bad_outcome/);
  assert.match(result.errors, /Allowed outcomes: approved/);
});

test("`docs` is listed as a payload command", () => {
  assert.match(run(["--help"]).output, /docs \[<topic>\]/);
});

test("`docs` lists its topics", async () => {
  const result = run(["docs"]);
  assert.equal(await result.code, 0);
  assert.equal(
    result.output,
    "format: The Loopfile format\nmanifest: The v1 manifest\nruntime: How a run works\nskill: The Loopfile agent skill\n",
  );
  assert.equal(result.errors, "");
});

test("the agent skill names only CLI commands and flags", async () => {
  const skill = await readFile(new URL("../skills/loopfile/SKILL.md", import.meta.url), "utf8");
  const rootHelp = run(["--help"]).output;

  for (const match of skill.matchAll(/`(loopfile [^`\n]+)`/g)) {
    const invocation = match[1];
    if (invocation === undefined) continue;
    const [command, ...args] = invocation.slice("loopfile ".length).split(/\s+/);
    if (command === undefined) continue;
    const help = command === "-" ? rootHelp : (await run([command, "--help"])).output;
    const cliTokens = new Set(
      help.split(/\s+/).map((token) => token.replace(/^[^\w-]+|[^\w-]+$/g, "")),
    );

    if (command !== "-") {
      assert.ok(cliTokens.has(command), `${command} is not in the CLI`);
    }
    for (const flag of args.filter((arg) => arg.startsWith("-"))) {
      assert.ok(cliTokens.has(flag), `${flag} named by ${invocation} is not in the CLI`);
    }
  }
});

test("`docs <topic>` prints the shipped markdown unchanged", async () => {
  const result = run(["docs", "manifest"]);
  assert.equal(await result.code, 0);
  assert.equal(
    result.output,
    readFileSync(new URL("../docs/manifest-v1.md", import.meta.url), "utf8"),
  );
  assert.equal(result.errors, "");
});

test("`docs skill` prints the agent skill byte for byte", async () => {
  const result = run(["docs", "skill"]);
  assert.equal(await result.code, 0);
  assert.equal(
    result.output,
    await readFile(new URL("../skills/loopfile/SKILL.md", import.meta.url), "utf8"),
  );
  assert.equal(result.errors, "");
});

test("npm pack ships the docs and examples used by the CLI", () => {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    }),
  );
  const files = pack.files.map(({ path }: { path: string }) => path);
  for (const path of [
    "docs/manifest-v1.md",
    "docs/loopfile-format.md",
    "docs/runtime.md",
    "skills/loopfile/SKILL.md",
    "examples/minimal/manifest.yaml",
  ]) {
    assert.ok(files.includes(path), `${path} is missing from npm pack`);
  }
});

test("an unknown docs topic uses the operator failure block", async () => {
  const result = run(["docs", "nope"]);
  assert.equal(await result.code, 2);
  assert.equal(result.output, "");
  assert.equal(
    result.errors,
    "error: unknown docs topic 'nope'\ncode: bad_argument\nhelp: Valid topics: format, manifest, runtime, skill\n",
  );
});

test("`list` is listed as a command", () => {
  assert.match(run(["--help"]).output, /list \[--json\]/);
});

test("`list` is dispatched by name and reports no runs on a fresh home", async () => {
  const result = run(["list"], {
    LOOPFILE_HOME: "/tmp/loopfile-cli-test-home-that-does-not-exist",
  });
  assert.equal(await result.code, 0);
  assert.equal(result.output, "no runs found\n");
  assert.equal(result.errors, "");
});

test("`logs` is listed as a command", () => {
  assert.match(run(["--help"]).output, /logs <runid> \[<attempt>\]/);
});

test("`logs` is dispatched by name and reports an operator failure on stderr only", async () => {
  const result = run(["logs", "no-such-run"], {
    LOOPFILE_HOME: "/tmp/loopfile-cli-test-home-that-does-not-exist",
  });
  assert.equal(await result.code, 2);
  assert.equal(result.output, "");
  assert.match(result.errors, /^error: unknown run: no-such-run/);
  assert.match(result.errors, /\ncode: no_such_run\n/);
  assert.match(result.errors, /\nhelp: /);
});

test("`tail` is listed as a command", () => {
  assert.match(run(["--help"]).output, /tail <runid> \[--json\]/);
});

test("`tail` is dispatched by name and reports an unknown run on stderr only", async () => {
  const result = run(["tail", "no-such-run"], {
    LOOPFILE_HOME: "/tmp/loopfile-cli-test-home-that-does-not-exist",
  });
  assert.equal(await result.code, 2);
  assert.equal(result.output, "");
  assert.match(result.errors, /^error: unknown run: no-such-run/);
});

test("`upgrade` is listed as a command", () => {
  assert.match(run(["--help"]).output, /upgrade <source>/);
});

test("`upgrade -` writes only the current stdin manifest to stdout", async () => {
  const manifest = `formatVersion: 1
steps:
  - id: run
    kind: command
    run: "true"
`;
  const result = run(["upgrade", "-"], {}, async () => Buffer.from(manifest));
  assert.equal(await result.code, 0);
  assert.equal(result.output, manifest);
  assert.equal(result.errors, "upgraded: -\nfrom: 1\nto: 1\n");
});

test("`upgrade` with no source prints the usage and exits 2", async () => {
  const result = run(["upgrade"]);
  assert.equal(await result.code, 2);
  assert.match(result.errors, /^error: upgrade takes one source\n/);
  assert.match(result.errors, /\ncode: bad_argument\n/);
  assert.match(result.errors, /\nhelp: Usage: loopfile upgrade <source>\n$/);
  assert.equal(result.output, "");
});

test("a command name wins over a directory of the same name, and only a path runs the directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loopfile-cli-list-"));
  await mkdir(join(cwd, "list"));
  await writeFile(join(cwd, "list", "manifest.yaml"), "formatVersion: 1\nsteps: []\n");
  const env = { LOOPFILE_HOME: join(cwd, "home") };
  try {
    const named = run(["list"], env);
    assert.equal(await named.code, 0);
    const path = run([join(cwd, "list")], env);
    assert.equal(await path.code, 1);
    assert.match(path.errors, /steps/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("--input or -d with no source is a usage error, not help", async () => {
  const result = run(["--input", "a=1"]);
  assert.equal(await result.code, 2);
  assert.match(result.errors, /Usage: loopfile <directory/);
});

test("remove has command help and is not run as a source", async () => {
  const help = run(["remove", "--help"]);
  assert.equal(await help.code, 0);
  assert.match(help.output, /Usage: loopfile remove <runid>/);
  assert.match(help.output, /--kill-leftovers/);

  const bare = run(["remove"]);
  assert.equal(await bare.code, 2);
  assert.match(bare.errors, /Usage: loopfile remove <runid>/);
});

test("prune removes only runs that cannot be resumed and skips dirty workspaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "loopfile-cli-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo, env: gitEnv });

  async function addRun(
    tail: string,
    end: "success" | "failure" | "cancelled" | "crashed" | "internal_error",
    dirty = false,
    at = new Date().toISOString(),
  ) {
    const runId = `20260921-120000-${tail}`;
    const paths = runPaths(home, runId);
    await mkdir(paths.root, { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "-b", `loopfile/${runId}`, paths.workspace, "HEAD"],
      {
        cwd: repo,
        env: gitEnv,
      },
    );
    const endEvent =
      end === "cancelled"
        ? { seq: 3, at, type: "run.cancelled" }
        : end === "crashed"
          ? undefined
          : {
              seq: 3,
              at,
              type: "run.ended",
              result: end === "success" ? "success" : "failure",
              reason: end === "internal_error" ? "internal_error" : "end_state",
            };
    await writeFile(
      paths.events,
      [
        {
          seq: 1,
          at,
          type: "run.created",
          runId,
          eventFormatVersion: 1,
          modelDigest: "digest",
          repositoryPath: repo,
          baseCommit: "0".repeat(40),
          branch: `loopfile/${runId}`,
          inputs: [],
        },
        { seq: 2, at, type: "owner.started", pid: 1, host: hostname() },
        ...(endEvent === undefined ? [] : [endEvent]),
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
    );
    if (dirty) await writeFile(join(paths.workspace, "uncommitted.txt"), "keep\n");
    return { runId, paths };
  }

  const completed = await addRun("aaaa", "success");
  const failed = await addRun("aaab", "failure");
  const cancelled = await addRun("aaac", "cancelled");
  const dirty = await addRun("aaad", "failure", true);
  const crashed = await addRun("aaae", "crashed");
  const internalError = await addRun("aaaf", "internal_error");
  const old = await addRun(
    "aaag",
    "success",
    false,
    new Date(Date.now() - 8 * 86_400_000).toISOString(),
  );
  const recent = await addRun(
    "aaah",
    "success",
    false,
    new Date(Date.now() - 86_400_000).toISOString(),
  );

  const dryRun = run(["prune", "--dry-run"], { LOOPFILE_HOME: home });
  assert.equal(await dryRun.code, 0);
  assert.equal(dryRun.output, "");
  for (const run of [completed, failed, cancelled, dirty, old, recent]) {
    assert.match(dryRun.errors, new RegExp(`would_remove: ${run.runId}\\n`));
    assert.equal((await stat(run.paths.root)).isDirectory(), true);
  }

  const older = run(["prune", "--older-than", "7d"], { LOOPFILE_HOME: home });
  assert.equal(await older.code, 0, older.errors);
  assert.match(older.errors, /^removed: 1\nskipped: 0\nfreed: /);
  await assert.rejects(stat(old.paths.root));
  assert.equal((await stat(recent.paths.root)).isDirectory(), true);

  const result = run(["prune"], { LOOPFILE_HOME: home });
  assert.equal(await result.code, 1);
  assert.equal(result.output, "");
  assert.match(result.errors, /^removed: 4\nskipped: 1\n/);
  assert.match(
    result.errors,
    new RegExp(`skipped: ${dirty.runId} workspace_dirty ${dirty.paths.workspace}\n`),
  );
  assert.match(result.errors, /freed: \d+(?:\.\d)? (?:B|KB|MB|GB|TB)\n$/);
  for (const run of [completed, failed, cancelled, recent])
    await assert.rejects(stat(run.paths.root));
  for (const run of [dirty, crashed, internalError]) {
    assert.equal((await stat(run.paths.root)).isDirectory(), true);
  }
  assert.match(
    execFileSync("git", ["branch", "--list", `loopfile/${completed.runId}`], {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
    }),
    new RegExp(completed.runId),
  );
});

test("prune rejects a bad age with an operator failure", async () => {
  const result = run(["prune", "--older-than", "seven days"]);
  assert.equal(await result.code, 2);
  assert.equal(result.output, "");
  assert.match(result.errors, /^error: invalid age: seven days\n/);
  assert.match(result.errors, /\ncode: bad_argument\n/);
  assert.match(
    result.errors,
    /\nhelp: Usage: loopfile prune \[--older-than <age>] \[--dry-run]\n$/,
  );
});

test("cancel is its own command and is not run as a source", async () => {
  const bare = run(["cancel"]);
  assert.equal(await bare.code, 2);
  assert.match(bare.errors, /Usage: loopfile cancel <runid>/);
  const unknown = run(["cancel", "no-such-run"], {
    LOOPFILE_HOME: "/tmp/loopfile-cli-test-home-that-does-not-exist",
  });
  assert.equal(await unknown.code, 2);
  assert.match(unknown.errors, /no run no-such-run/);
  assert.match(unknown.errors, /\ncode: no_such_run\n/);
  assert.equal(unknown.output, "");
});
