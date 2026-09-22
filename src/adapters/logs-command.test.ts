import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attemptPaths, iterationPaths } from "./attempt-directory.ts";
import { logsCommand } from "./logs-command.ts";
import { runPaths } from "./run-directory.ts";

const home = await mkdtemp(join(tmpdir(), "loopfile-logs-"));
const env = { LOOPFILE_HOME: home };

function runner() {
  let output = "";
  let errors = "";
  const out = (bytes: string | Uint8Array): void => {
    output += typeof bytes === "string" ? bytes : Buffer.from(bytes).toString();
  };
  const err = (text: string): void => {
    errors += text;
  };
  return {
    out,
    err,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}

async function makeAttempt(runId: string, attemptId: string) {
  const paths = runPaths(home, runId);
  await mkdir(paths.attempts, { recursive: true });
  return attemptPaths(paths.attempts, attemptId);
}

test("an unknown run ID gives the operator failure block and exits 2", async () => {
  const r = runner();
  const code = await logsCommand(["logs", "no-such-run"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /^error: unknown run: no-such-run/);
  assert.match(r.errors, /\ncode: no_such_run\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("a run with no attempts gives a clear error and exits 2", async () => {
  const runId = "run-empty";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  const r = runner();
  const code = await logsCommand(["logs", runId], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /^error: /);
  assert.match(r.errors, /has no attempts/);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("an unknown attempt lists the valid ones and exits 2", async () => {
  const runId = "run-unknown-attempt";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  const r = runner();
  const code = await logsCommand(["logs", runId, "9"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /^error: /);
  assert.match(r.errors, /unknown attempt/);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
  assert.match(r.errors, /001-implement/);
});

test("prints stderr then stdout by default, each behind a header, and the folder path first", async () => {
  const runId = "run-default";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  await writeFile(attempt.stdout, "the payload\n");
  await writeFile(attempt.stderr, "a hint\n");

  const r = runner();
  const code = await logsCommand(["logs", runId], r.out, r.err, env);

  assert.equal(code, 0);
  assert.equal(r.output, "a hint\nthe payload\n");
  assert.match(r.errors, new RegExp(`^${attempt.root}\\n`));
  const stderrHeaderIndex = r.errors.indexOf("--- stderr ---");
  const stdoutHeaderIndex = r.errors.indexOf("--- stdout ---");
  assert.ok(stderrHeaderIndex > -1 && stdoutHeaderIndex > stderrHeaderIndex);
});

test("--stdout prints only that file's bytes, with no header", async () => {
  const runId = "run-stdout-only";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  await writeFile(attempt.stdout, "just the payload\n");
  await writeFile(attempt.stderr, "not this\n");

  const r = runner();
  const code = await logsCommand(["logs", runId, "--stdout"], r.out, r.err, env);

  assert.equal(code, 0);
  assert.equal(r.output, "just the payload\n");
  assert.doesNotMatch(r.errors, /---/);
});

test("--stderr prints only that file's bytes, with no header", async () => {
  const runId = "run-stderr-only";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  await writeFile(attempt.stdout, "not this\n");
  await writeFile(attempt.stderr, "just the hint\n");

  const r = runner();
  const code = await logsCommand(["logs", runId, "--stderr"], r.out, r.err, env);

  assert.equal(code, 0);
  assert.equal(r.output, "just the hint\n");
});

test("--owner prints owner.log byte for byte", async () => {
  const runId = "run-owner";
  const paths = runPaths(home, runId);
  const bytes = Buffer.from([0, 10, 255, 32]);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.ownerLog, bytes);

  let output = Buffer.alloc(0);
  const code = await logsCommand(
    ["logs", runId, "--owner"],
    (value) => {
      output = Buffer.concat([output, typeof value === "string" ? Buffer.from(value) : value]);
    },
    () => {},
    env,
  );

  assert.equal(code, 0);
  assert.deepEqual(output, bytes);
});

test("an empty or missing output file is not an error", async () => {
  const runId = "run-missing-file";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  // Neither stdout nor stderr is written: a step can die before writing one.

  const r = runner();
  const code = await logsCommand(["logs", runId], r.out, r.err, env);

  assert.equal(code, 0);
  assert.equal(r.output, "");
});

test("attempt selection accepts a bare number and a folder name", async () => {
  const runId = "run-selection";
  const first = await makeAttempt(runId, "001-implement");
  const second = await makeAttempt(runId, "002-test");
  await mkdir(first.root, { recursive: true });
  await mkdir(second.root, { recursive: true });
  await writeFile(first.stdout, "first\n");
  await writeFile(second.stdout, "second\n");

  const byNumber = runner();
  await logsCommand(["logs", runId, "1", "--stdout"], byNumber.out, byNumber.err, env);
  assert.equal(byNumber.output, "first\n");

  const byName = runner();
  await logsCommand(["logs", runId, "002-test", "--stdout"], byName.out, byName.err, env);
  assert.equal(byName.output, "second\n");
});

test("with no attempt given, the newest attempt is shown", async () => {
  const runId = "run-newest";
  const first = await makeAttempt(runId, "001-implement");
  const second = await makeAttempt(runId, "002-test");
  await mkdir(first.root, { recursive: true });
  await mkdir(second.root, { recursive: true });
  await writeFile(first.stdout, "first\n");
  await writeFile(second.stdout, "second\n");

  const r = runner();
  await logsCommand(["logs", runId, "--stdout"], r.out, r.err, env);
  assert.equal(r.output, "second\n");
});

test("it works after status.json is deleted and with no run owner alive", async () => {
  const runId = "run-orphan";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  await writeFile(attempt.stdout, "orphaned output\n");
  // No status.json is ever written in this test, and nothing runs an owner.

  const r = runner();
  const code = await logsCommand(["logs", runId, "--stdout"], r.out, r.err, env);
  assert.equal(code, 0);
  assert.equal(r.output, "orphaned output\n");
});

test("it never writes any run file", async () => {
  const runId = "run-readonly";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  await writeFile(attempt.stdout, "hello\n");

  const r = runner();
  await logsCommand(["logs", runId], r.out, r.err, env);
  const after = await readFile(attempt.stdout, "utf8");
  assert.equal(after, "hello\n");
});

test("a Ralph attempt prints every iteration in order, each behind a header", async () => {
  const runId = "run-ralph";
  const attempt = await makeAttempt(runId, "001-review");
  await mkdir(attempt.root, { recursive: true });
  const first = iterationPaths(attempt, 1);
  const second = iterationPaths(attempt, 2);
  await mkdir(first.root, { recursive: true });
  await mkdir(second.root, { recursive: true });
  await writeFile(first.stdout, "iteration one out\n");
  await writeFile(first.stderr, "iteration one err\n");
  await writeFile(second.stdout, "iteration two out\n");
  await writeFile(second.stderr, "iteration two err\n");

  const r = runner();
  const code = await logsCommand(["logs", runId], r.out, r.err, env);

  assert.equal(code, 0);
  assert.equal(
    r.output,
    "iteration one err\niteration one out\niteration two err\niteration two out\n",
  );
  const first01 = r.errors.indexOf("--- iteration 01 ---");
  const first02 = r.errors.indexOf("--- iteration 02 ---");
  assert.ok(first01 > -1 && first02 > first01);
});

test("--iteration on a Ralph attempt prints only that iteration", async () => {
  const runId = "run-ralph-one";
  const attempt = await makeAttempt(runId, "001-review");
  await mkdir(attempt.root, { recursive: true });
  const first = iterationPaths(attempt, 1);
  const second = iterationPaths(attempt, 2);
  await mkdir(first.root, { recursive: true });
  await mkdir(second.root, { recursive: true });
  await writeFile(first.stdout, "iteration one\n");
  await writeFile(second.stdout, "iteration two\n");

  const r = runner();
  const code = await logsCommand(
    ["logs", runId, "--iteration", "2", "--stdout"],
    r.out,
    r.err,
    env,
  );

  assert.equal(code, 0);
  assert.equal(r.output, "iteration two\n");
});

test("an unknown --iteration lists the valid ones and exits 2", async () => {
  const runId = "run-ralph-unknown-iteration";
  const attempt = await makeAttempt(runId, "001-review");
  await mkdir(attempt.root, { recursive: true });
  const first = iterationPaths(attempt, 1);
  await mkdir(first.root, { recursive: true });

  const r = runner();
  const code = await logsCommand(["logs", runId, "--iteration", "9"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /error: /);
  assert.match(r.errors, /unknown iteration/);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
  assert.match(r.errors, /01/);
});

test("--iteration on a non-Ralph attempt is an operator error", async () => {
  const runId = "run-not-ralph";
  const attempt = await makeAttempt(runId, "001-implement");
  await mkdir(attempt.root, { recursive: true });
  await writeFile(attempt.stdout, "no iterations here\n");

  const r = runner();
  const code = await logsCommand(["logs", runId, "--iteration", "1"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /error: /);
  assert.match(r.errors, /--iteration only works on a Ralph attempt/);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
  assert.equal(r.output, "");
});

test("a stray non-attempt directory in attempts/ is ignored, not picked as newest", async () => {
  const runId = "run-stray";
  const paths = runPaths(home, runId);
  await mkdir(join(paths.attempts, "stray"), { recursive: true });
  const real = await makeAttempt(runId, "001-implement");
  await mkdir(real.root, { recursive: true });
  await writeFile(real.stdout, "the real attempt\n");

  const r = runner();
  const code = await logsCommand(["logs", runId, "--stdout"], r.out, r.err, env);

  assert.equal(code, 0);
  assert.equal(r.output, "the real attempt\n");
});

test("a stray non-attempt directory is left out of the unknown-attempt listing", async () => {
  const runId = "run-stray-listing";
  const paths = runPaths(home, runId);
  await mkdir(join(paths.attempts, "stray"), { recursive: true });
  const real = await makeAttempt(runId, "001-implement");
  await mkdir(real.root, { recursive: true });

  const r = runner();
  const code = await logsCommand(["logs", runId, "9"], r.out, r.err, env);

  assert.equal(code, 2);
  assert.match(r.errors, /^error: /);
  assert.match(r.errors, /Valid attempts: 001-implement$/m);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("a permission error reading the run folder is not reported as an unknown run", async () => {
  const runId = "run-forbidden";
  const paths = runPaths(home, runId);
  await mkdir(paths.attempts, { recursive: true });
  await chmod(paths.root, 0o000);

  try {
    const r = runner();
    const code = await logsCommand(["logs", runId], r.out, r.err, env);
    assert.equal(code, 2);
    assert.match(r.errors, /^error: /);
    assert.doesNotMatch(r.errors, /unknown run/);
    assert.match(r.errors, /\ncode: log_unreadable\n/);
    assert.match(r.errors, /\nhelp: /);
  } finally {
    await chmod(paths.root, 0o755);
  }
});

test("cleanup", async () => {
  await rm(home, { recursive: true, force: true });
});
