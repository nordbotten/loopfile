import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { STATUS_FORMAT_VERSION } from "../domain/status.ts";
import { resultCommand } from "./result-command.ts";
import { runPaths } from "./run-directory.ts";

const home = await mkdtemp(join(tmpdir(), "loopfile-result-"));
const env = { LOOPFILE_HOME: home };
after(() => rm(home, { recursive: true, force: true }));

function capture() {
  let output = "";
  let errors = "";
  return {
    out: (text: string) => {
      output += text;
    },
    err: (text: string) => {
      errors += text;
    },
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}

function status(runId: string, running: boolean, end: "success" | "failure" | "cancelled") {
  return {
    formatVersion: STATUS_FORMAT_VERSION,
    seq: 1,
    updatedAt: "2026-09-21T14:00:00.000Z",
    runId,
    loopfileName: "review-loop",
    state: running
      ? "running"
      : end === "success"
        ? "completed"
        : end === "failure"
          ? "failed"
          : "cancelled",
    endReason: running ? null : end,
    startedAt: "2026-09-21T14:00:00.000Z",
    endedAt: running ? null : "2026-09-21T14:01:00.000Z",
    current: null,
    lastActivityAt: "2026-09-21T14:00:00.000Z",
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
  };
}

async function makeRun(
  runId: string,
  ended: boolean,
  end: "success" | "failure" | "cancelled" = "success",
  reason = "end_state",
) {
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  const events = [
    {
      seq: 1,
      at: "2026-09-21T14:00:00.000Z",
      type: "run.created",
      runId,
      eventFormatVersion: 1,
      modelDigest: "sha256:model",
      repositoryPath: "/repo",
      branch: `loopfile/${runId}`,
      baseCommit: "abc123",
      inputs: [],
    },
    {
      seq: 2,
      at: "2026-09-21T14:00:10.000Z",
      type: "attempt.started",
      attemptId: "001-review",
      stepId: "review",
      processGroupId: 1,
    },
    {
      seq: 3,
      at: "2026-09-21T14:00:20.000Z",
      type: "outcome.reported",
      attemptId: "001-review",
      outcome: "approved",
      message: "first answer",
    },
    {
      seq: 4,
      at: "2026-09-21T14:00:30.000Z",
      type: "outcome.reported",
      attemptId: "001-review",
      outcome: "changes_requested",
    },
    ...(ended
      ? [
          end === "cancelled"
            ? {
                seq: 5,
                at: "2026-09-21T14:01:00.000Z",
                type: "run.cancelled",
              }
            : {
                seq: 5,
                at: "2026-09-21T14:01:00.000Z",
                type: "run.ended",
                result: end,
                reason,
              },
        ]
      : []),
  ];
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(paths.status, JSON.stringify(status(runId, !ended, end)));
}

test("a finished run prints all operator facts as JSON and exits 0", async () => {
  const runId = "20260921-140000-aaaa";
  await makeRun(runId, true);
  const output = capture();
  const code = await resultCommand(["result", runId, "--json"], output.out, output.err, env);

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output.output), {
    formatVersion: 1,
    runId,
    loopfileName: "review-loop",
    state: "completed",
    endReason: "success",
    startedAt: "2026-09-21T14:00:00.000Z",
    endedAt: "2026-09-21T14:01:00.000Z",
    repositoryPath: "/repo",
    branch: `loopfile/${runId}`,
    baseCommit: "abc123",
    metrics: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      toolCalls: null,
      permissionDenials: null,
    },
    lastOutcome: {
      stepId: "review",
      attemptId: "001-review",
      outcome: "changes_requested",
      message: null,
    },
    inputs: {},
    outputs: {},
  });
  assert.equal(output.errors, "");
});

test("result includes declared inputs and outputs, not scratch data", async () => {
  const runId = "20260921-140000-values";
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.loopfile, { recursive: true });
  await writeFile(
    join(paths.loopfile, "manifest.yaml"),
    `formatVersion: 1
inputs:
  issue: issue number
steps:
  - id: work
    kind: command
    run: "true"
    outputs: [answer, log, missing, large]
`,
  );
  await mkdir(paths.inputs, { recursive: true });
  await writeFile(join(paths.inputs, "issue"), "42");
  for (const attempt of ["001-work", "002-work"]) {
    await mkdir(join(paths.attempts, attempt, "data"), { recursive: true });
  }
  await writeFile(join(paths.attempts, "001-work", "data", "work.answer"), "old");
  await writeFile(join(paths.attempts, "002-work", "data", "work.answer"), "newest");
  await writeFile(join(paths.attempts, "001-work", "data", "work.log"), "first");
  await writeFile(join(paths.attempts, "001-work", "data", "work.log@1"), "second");
  await mkdir(join(paths.root, "result-values"), { recursive: true });
  await writeFile(join(paths.root, "result-values", "work.log"), "first\nsecond");
  const large = "x".repeat(64 * 1024 + 1);
  await writeFile(join(paths.attempts, "001-work", "data", "work.large"), large);
  const events = [
    {
      seq: 1,
      at: "2026-09-21T14:00:00.000Z",
      type: "run.created",
      runId,
      eventFormatVersion: 1,
      modelDigest: "sha256:model",
      repositoryPath: "/repo",
      branch: `loopfile/${runId}`,
      baseCommit: "abc123",
      inputs: [{ name: "issue", size: 2, digest: "digest" }],
    },
    {
      seq: 2,
      at: "2026-09-21T14:00:10.000Z",
      type: "attempt.started",
      attemptId: "001-work",
      stepId: "work",
      processGroupId: 1,
    },
    {
      seq: 3,
      at: "2026-09-21T14:00:20.000Z",
      type: "data.put",
      attemptId: "001-work",
      key: "work.answer",
      size: 3,
      digest: "old",
    },
    {
      seq: 4,
      at: "2026-09-21T14:00:30.000Z",
      type: "data.put",
      attemptId: "001-work",
      key: "work.log",
      size: 5,
      digest: "first",
      appended: true,
      writeIndex: 0,
    },
    {
      seq: 5,
      at: "2026-09-21T14:00:40.000Z",
      type: "data.put",
      attemptId: "001-work",
      key: "work.log",
      size: 6,
      digest: "second",
      appended: true,
      writeIndex: 1,
    },
    {
      seq: 6,
      at: "2026-09-21T14:00:50.000Z",
      type: "data.put",
      attemptId: "001-work",
      key: "work.large",
      size: large.length,
      digest: "large",
    },
    {
      seq: 7,
      at: "2026-09-21T14:01:00.000Z",
      type: "data.put",
      attemptId: "001-work",
      key: "work.scratch",
      size: 5,
      digest: "scratch",
    },
    {
      seq: 8,
      at: "2026-09-21T14:01:10.000Z",
      type: "attempt.started",
      attemptId: "002-work",
      stepId: "work",
      processGroupId: 2,
    },
    {
      seq: 9,
      at: "2026-09-21T14:01:20.000Z",
      type: "data.put",
      attemptId: "002-work",
      key: "work.answer",
      size: 6,
      digest: "newest",
    },
    {
      seq: 10,
      at: "2026-09-21T14:01:30.000Z",
      type: "run.ended",
      result: "success",
      reason: "end_state",
    },
  ];
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(paths.status, JSON.stringify(status(runId, false, "success")));

  const output = capture();
  assert.equal(await resultCommand(["result", runId, "--json"], output.out, output.err, env), 0);
  const result = JSON.parse(output.output);
  assert.equal(result.inputs.issue.value, "42");
  assert.equal(result.outputs["work.answer"].value, "newest");
  assert.equal(result.outputs["work.log"].value, "first\nsecond");
  assert.equal(result.outputs["work.missing"].value, null);
  assert.equal(result.outputs["work.scratch"], undefined);
  assert.equal(result.outputs["work.large"].truncated, true);
  assert.equal(result.outputs["work.large"].value, "x".repeat(64 * 1024));
  assert.equal(await readFile(result.outputs["work.large"].path, "utf8"), large);
  assert.equal(output.errors, "");

  const text = capture();
  assert.equal(await resultCommand(["result", runId], text.out, text.err, env), 0);
  assert.match(text.output, /^run +20260921-140000-values · review-loop$/m);
  assert.match(text.output, /^input +issue: 42$/m);
  assert.match(text.output, /^output +work\.log: first second$/m);
  assert.doesNotMatch(text.output, /first\nsecond/);
  assert.equal(text.errors, "");
});

test("a live run prints running facts and exits 2", async () => {
  const runId = "20260921-140001-bbbb";
  await makeRun(runId, false);
  const output = capture();
  const code = await resultCommand(["result", runId, "--json"], output.out, output.err, env);

  assert.equal(code, 2);
  assert.equal(JSON.parse(output.output).state, "running");
  assert.equal(JSON.parse(output.output).endReason, null);
  assert.equal(JSON.parse(output.output).endedAt, null);
  assert.equal(output.errors, "");
});

test("failed and cancelled runs print their terminal state and exit 1", async () => {
  for (const [runId, end, state, reason] of [
    ["20260921-140002-cccc", "failure", "failed", "failure"],
    ["20260921-140003-dddd", "cancelled", "cancelled", "cancelled"],
  ] as const) {
    await makeRun(runId, true, end);
    const output = capture();
    const code = await resultCommand(["result", runId, "--json"], output.out, output.err, env);

    assert.equal(code, 1);
    assert.equal(JSON.parse(output.output).state, state);
    assert.equal(JSON.parse(output.output).endReason, reason);
    assert.equal(output.errors, "");
  }
});

test("an internal error puts the last 20 owner log lines in help", async () => {
  const runId = "20260921-140004-internal";
  await makeRun(runId, true, "failure", "internal_error");
  await writeFile(
    runPaths(home, runId).ownerLog,
    Array.from({ length: 21 }, (_, i) => `line ${i}`).join("\n"),
  );

  const output = capture();
  assert.equal(await resultCommand(["result", runId, "--json"], output.out, output.err, env), 1);
  assert.equal(JSON.parse(output.output).endReason, "internal_error");
  assert.match(output.errors, /^error: run .* failed: internal_error\ncode: operation_failed\n/);
  assert.match(output.errors, /help: "End of .*owner\.log:\\nline 1/);
  assert.match(output.errors, /\\nline 20"\n$/);
  assert.doesNotMatch(output.errors, /line 0/);
});

test("unreadable event and status files exit 2 without JSON output", async () => {
  const corruptRun = "20260921-140004-eeee";
  await makeRun(corruptRun, true);
  const corruptPaths = runPaths(home, corruptRun);
  await writeFile(
    corruptPaths.events,
    '{"seq":1,"at":"2026-09-21T14:00:00.000Z","type":"run.created"}\nnot json\n{"seq":3,"at":"2026-09-21T14:00:01.000Z","type":"owner.started"}\n',
  );
  const corrupt = capture();
  assert.equal(
    await resultCommand(["result", corruptRun, "--json"], corrupt.out, corrupt.err, env),
    2,
  );
  assert.equal(corrupt.output, "");
  assert.match(corrupt.errors, /\ncode: log_corrupt\n/);

  const missingStatusRun = "20260921-140005-ffff";
  await makeRun(missingStatusRun, true);
  await rm(runPaths(home, missingStatusRun).status);
  const missingStatus = capture();
  assert.equal(
    await resultCommand(
      ["result", missingStatusRun, "--json"],
      missingStatus.out,
      missingStatus.err,
      env,
    ),
    2,
  );
  assert.equal(missingStatus.output, "");
  assert.match(missingStatus.errors, /\ncode: log_unreadable\n/);
});

test("result help and unknown runs use their separate output paths", async () => {
  const help = capture();
  assert.equal(await resultCommand(["result", "--help"], help.out, help.err, env), 0);
  assert.match(help.output, /^Usage: loopfile result/);
  assert.equal(help.errors, "");

  const missing = capture();
  assert.equal(
    await resultCommand(
      ["result", "20260921-140099-zzzz", "--json"],
      missing.out,
      missing.err,
      env,
    ),
    2,
  );
  assert.equal(missing.output, "");
  assert.match(missing.errors, /\ncode: no_such_run\n/);
});
