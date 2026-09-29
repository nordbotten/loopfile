import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RemoteRecord } from "../domain/events.ts";
import { STATUS_FORMAT_VERSION } from "../domain/status.ts";
import { resultCommand } from "./result-command.ts";
import { loopPaths, runPaths } from "./run-directory.ts";

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

function status(
  runId: string,
  running: boolean,
  end: "success" | "failure" | "cancelled",
  remote?: RemoteRecord,
) {
  return {
    formatVersion: STATUS_FORMAT_VERSION,
    seq: 1,
    updatedAt: "2026-09-21T14:00:00.000Z",
    runId,
    loopfileName: "review-loop",
    ...(remote === undefined ? {} : { remote }),
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
  remote?: RemoteRecord,
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
      targetFolder: "/repo",
      ...(remote === undefined ? {} : { remote }),
      workspacePath: `${home}/runs/${runId}/workspace`,
      workspaceMode: "isolate",
      isolateKind: "worktree",
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
  await writeFile(paths.status, JSON.stringify(status(runId, !ended, end, remote)));
}

async function makeRunWithCallEvents(
  runId: string,
  callEvents: readonly Record<string, unknown>[],
): Promise<void> {
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
      targetFolder: "/repo",
      workspacePath: `${home}/runs/${runId}/workspace`,
      workspaceMode: "isolate",
      isolateKind: "worktree",
      branch: `loopfile/${runId}`,
      baseCommit: "abc123",
      inputs: [],
    },
    ...callEvents,
    {
      seq: callEvents.length + 2,
      at: "2026-09-21T14:01:00.000Z",
      type: "run.ended",
      result: "success",
      reason: "end_state",
    },
  ];
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(paths.status, JSON.stringify(status(runId, false, "success")));
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
    loopId: null,
    loopIndex: null,
    remote: null,
    state: "completed",
    endReason: "success",
    startedAt: "2026-09-21T14:00:00.000Z",
    endedAt: "2026-09-21T14:01:00.000Z",
    targetFolder: "/repo",
    workspace: `${home}/runs/${runId}/workspace`,
    workspaceMode: "isolate",
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

test("result JSON shows the fields of the last call that reported the outcome", async () => {
  const runId = "20260921-140000-last-call";
  await makeRunWithCallEvents(runId, [
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
      type: "iteration.started",
      attemptId: "001-review",
      iteration: 1,
      processGroupId: 2,
      fields: { model: "sonnet", effort: "low" },
    },
    {
      seq: 4,
      at: "2026-09-21T14:00:30.000Z",
      type: "iteration.ended",
      attemptId: "001-review",
      iteration: 1,
      reason: "no_outcome",
    },
    {
      seq: 5,
      at: "2026-09-21T14:00:40.000Z",
      type: "iteration.started",
      attemptId: "001-review",
      iteration: 2,
      processGroupId: 3,
      fields: { model: "opus", effort: "high" },
    },
    {
      seq: 6,
      at: "2026-09-21T14:00:50.000Z",
      type: "outcome.reported",
      attemptId: "001-review",
      iteration: 2,
      outcome: "changes_requested",
    },
  ]);

  const output = capture();
  assert.equal(await resultCommand(["result", runId, "--json"], output.out, output.err, env), 0);
  assert.deepEqual(JSON.parse(output.output).lastOutcome.fields, {
    model: "opus",
    effort: "high",
  });
});

test("result JSON omits fields when the last call did not record a map", async () => {
  const runId = "20260921-140000-no-call-fields";
  await makeRunWithCallEvents(runId, [
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
      type: "iteration.started",
      attemptId: "001-review",
      iteration: 1,
      processGroupId: 2,
      fields: { model: "sonnet" },
    },
    {
      seq: 4,
      at: "2026-09-21T14:00:30.000Z",
      type: "iteration.ended",
      attemptId: "001-review",
      iteration: 1,
      reason: "no_outcome",
    },
    {
      seq: 5,
      at: "2026-09-21T14:00:40.000Z",
      type: "iteration.started",
      attemptId: "001-review",
      iteration: 2,
      processGroupId: 3,
    },
    {
      seq: 6,
      at: "2026-09-21T14:00:50.000Z",
      type: "outcome.reported",
      attemptId: "001-review",
      iteration: 2,
      outcome: "changes_requested",
    },
  ]);

  const output = capture();
  assert.equal(await resultCommand(["result", runId, "--json"], output.out, output.err, env), 0);
  assert.equal(Object.hasOwn(JSON.parse(output.output).lastOutcome, "fields"), false);
});

test("the plain result adds the last outcome call fields", async () => {
  const runId = "20260921-140000-human-fields";
  await makeRunWithCallEvents(runId, [
    {
      seq: 2,
      at: "2026-09-21T14:00:10.000Z",
      type: "attempt.started",
      attemptId: "001-review",
      stepId: "review",
      processGroupId: 1,
      fields: { model: "opus", effort: "high" },
    },
    {
      seq: 3,
      at: "2026-09-21T14:00:20.000Z",
      type: "outcome.reported",
      attemptId: "001-review",
      outcome: "changes_requested",
    },
  ]);

  const output = capture();
  assert.equal(await resultCommand(["result", runId], output.out, output.err, env), 0);
  assert.match(
    output.output,
    /^last outcome +review \(001-review\) · changes_requested · model opus effort high$/m,
  );
});

test("the human result prints the target and workspace", async () => {
  const runId = "20260921-140000-human";
  await makeRun(runId, true);
  const output = capture();
  assert.equal(await resultCommand(["result", runId], output.out, output.err, env), 0);
  assert.equal(
    output.output,
    `run          ${runId} · review-loop\n` +
      "state        completed\n" +
      "started      2026-09-21T14:00:00.000Z\n" +
      "ended        success at 2026-09-21T14:01:00.000Z\n" +
      "target       /repo\n" +
      `workspace    isolate · ${home}/runs/${runId}/workspace\n` +
      `branch       loopfile/${runId}\n` +
      "base commit  abc123\n" +
      "last outcome review (001-review) · changes_requested\n" +
      "inputs       none\n" +
      "outputs      none\n",
  );
  assert.equal(output.errors, "");
});

test("human result shows remote source with and without optional path and ref", async () => {
  for (const [runId, remote, line] of [
    [
      "20260921-140010-rmaa",
      {
        host: "github.com",
        repo: "acme/loops",
        path: "review",
        ref: "main",
        sha: "4c9d077abcde1234567890abcdef1234567890ab",
      },
      "remote: github.com/acme/loops/review @ main (4c9d077)",
    ],
    [
      "20260921-140011-rmab",
      {
        host: "github.com",
        repo: "acme/loops",
        path: "review",
        sha: "4c9d077abcde1234567890abcdef1234567890ab",
      },
      "remote: github.com/acme/loops/review (4c9d077)",
    ],
    [
      "20260921-140012-rmac",
      {
        host: "github.com",
        repo: "acme/loops",
        ref: "main",
        sha: "4c9d077abcde1234567890abcdef1234567890ab",
      },
      "remote: github.com/acme/loops @ main (4c9d077)",
    ],
    [
      "20260921-140013-rmad",
      { host: "github.com", repo: "acme/loops", sha: "4c9d077abcde1234567890abcdef1234567890ab" },
      "remote: github.com/acme/loops (4c9d077)",
    ],
  ] as const) {
    await makeRun(runId, true, "success", "end_state", remote);
    const output = capture();
    assert.equal(await resultCommand(["result", runId], output.out, output.err, env), 0);
    assert.equal(output.output.split("\n")[1], line);
    assert.equal(output.errors, "");

    const json = capture();
    assert.equal(await resultCommand(["result", runId, "--json"], json.out, json.err, env), 0);
    assert.deepEqual(JSON.parse(json.output).remote, remote);
  }
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
      targetFolder: "/repo",
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

test("result collects every run from a completed loop in text and JSON", async () => {
  const loopId = "loop-20260921-140100-abcd";
  const remote = {
    host: "github.com",
    repo: "acme/loops",
    path: "review",
    ref: "main",
    sha: "4c9d077abcde1234567890abcdef1234567890ab",
  };
  const runs = [
    { runId: "20260921-140101-aaaa", inputSet: { issue: "41" }, remote },
    { runId: "20260921-140102-bbbb", inputSet: { issue: "42" }, remote: undefined },
  ];
  for (const run of runs) await makeRun(run.runId, true, "success", "end_state", run.remote);
  await makeLoopResult(loopId, runs, "source_empty");

  const json = capture();
  assert.equal(await resultCommand(["result", loopId, "--json"], json.out, json.err, env), 0);
  assert.deepEqual(JSON.parse(json.output), {
    loopId,
    state: "completed",
    endReason: "source_empty",
    cancelMode: null,
    detail: null,
    runs: runs.map(({ runId, inputSet }, position) => ({
      index: position + 1,
      runId,
      inputSet,
      retryOf: null,
      state: "completed",
      endReason: "success",
      remote: runs[position]?.remote ?? null,
      branch: `loopfile/${runId}`,
    })),
  });
  assert.equal(json.errors, "");

  const text = capture();
  assert.equal(await resultCommand(["result", loopId], text.out, text.err, env), 0);
  assert.equal(
    text.output,
    `loop: ${loopId}\nstate: completed\nended: source_empty\n\n` +
      `run 1: ${runs[0]?.runId}\n  input set: issue=41\n  state: completed\n` +
      `  end reason: success\n  branch: loopfile/${runs[0]?.runId}\n\n` +
      `run 2: ${runs[1]?.runId}\n  input set: issue=42\n  state: completed\n` +
      `  end reason: success\n  branch: loopfile/${runs[1]?.runId}\n`,
  );
  assert.equal(text.errors, "");
});

test("result for a loop ended with run_failed exits 1", async () => {
  const loopId = "loop-20260921-140200-cccc";
  const runId = "20260921-140201-cccc";
  await makeRun(runId, true, "failure");
  await makeLoopResult(loopId, [{ runId, inputSet: {} }], "run_failed", {
    detail: `run ${runId} failed`,
  });

  const output = capture();
  assert.equal(await resultCommand(["result", loopId, "--json"], output.out, output.err, env), 1);
  assert.equal(JSON.parse(output.output).endReason, "run_failed");
  assert.equal(JSON.parse(output.output).runs[0].state, "failed");
  assert.equal(output.errors, "");
});

test("a cancelled loop result shows its cancel mode and detail", async () => {
  const loopId = "loop-20260921-140250-eeee";
  await makeLoopResult(loopId, [], "cancelled", {
    cancelMode: "after_run",
    detail: "stopped after the current run",
  });

  const output = capture();
  assert.equal(await resultCommand(["result", loopId], output.out, output.err, env), 1);
  assert.equal(
    output.output,
    `loop: ${loopId}\nstate: cancelled\nended: cancelled (after_run) - stopped after the current run\n`,
  );
  assert.equal(output.errors, "");
});

test("a running loop result matches a running run result's exit and output behavior", async () => {
  const loopId = "loop-20260921-140300-dddd";
  const runId = "20260921-140301-dddd";
  await makeLoopResult(loopId, [{ runId, inputSet: {} }], null);

  const output = capture();
  assert.equal(await resultCommand(["result", loopId, "--json"], output.out, output.err, env), 2);
  assert.equal(JSON.parse(output.output).state, "running");
  assert.equal(JSON.parse(output.output).endReason, null);
  assert.equal(output.errors, "");
});

test("result for a missing loop uses no_such_loop", async () => {
  const output = capture();
  assert.equal(
    await resultCommand(["result", "loop-20260921-140400-eeee"], output.out, output.err, env),
    2,
  );
  assert.equal(output.output, "");
  assert.match(output.errors, /\ncode: no_such_loop\n/);
});

async function makeLoopResult(
  loopId: string,
  runs: readonly {
    readonly runId: string;
    readonly inputSet: Readonly<Record<string, string>>;
    readonly retryOf?: string | null;
  }[],
  endReason: string | null,
  end: { readonly cancelMode?: string; readonly detail?: string } = {},
): Promise<void> {
  const paths = loopPaths(home, loopId);
  await mkdir(paths.root, { recursive: true });
  const events = [
    {
      seq: 1,
      at: "2026-09-21T14:00:00.000Z",
      type: "loop.created",
      loopId,
      eventFormatVersion: 1,
      repositoryPath: "/repo",
      loopfileName: "review-loop",
      source: { kind: "times", count: runs.length },
      fixedInputs: {},
      retry: 0,
      maxRuns: null,
      pauseMs: null,
      program: { version: "0.2.0", digest: "sha256:program" },
    },
    ...runs.map((run, position) => ({
      seq: position + 2,
      at: `2026-09-21T14:00:0${position + 1}.000Z`,
      type: "loop.run_started",
      runId: run.runId,
      index: position + 1,
      inputSet: run.inputSet,
      sourceIndex: position + 1,
      retryOf: run.retryOf ?? null,
    })),
    ...(endReason === null
      ? []
      : [
          {
            seq: runs.length + 2,
            at: "2026-09-21T14:01:00.000Z",
            type: "loop.ended",
            result: endReason === "source_empty" ? "success" : "failure",
            reason: endReason,
            ...end,
          },
        ]),
  ];
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}
