import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { HarnessActivity, HarnessCall } from "../application/harness.ts";
import { parseEventLog } from "../application/replay.ts";
import type { AttemptId } from "../domain/model.ts";
import { createAttemptDirectory } from "./attempt-directory.ts";
import { dataGetHandler } from "./data-get-handler.ts";
import { dataPutHandler } from "./data-put-handler.ts";
import {
  type FakeAction,
  type FakeScript,
  fakeHarness,
  fakeHarnessAdapters,
} from "./fake-harness.test.ts";
import { startHarnessCall } from "./harness-call.ts";
import { localExecutor } from "./local-executor.ts";
import { resultHandler } from "./result-handler.ts";
import { runPaths } from "./run-directory.ts";
import { startRunOwner } from "./run-owner.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-fake-"));
test.after(() => rm(scratch, { recursive: true, force: true }));

const executor = localExecutor(process.env, 200);
let counter = 0;

/** A run owner, a workspace, and a way to run one call of `stepId` as attempt `attemptId`. */
async function newRig(script: FakeScript) {
  counter += 1;
  const home = join(scratch, `home-${counter}`);
  const runId = `20260917-160344-r${counter}`;
  const workspace = await realpath(await mkdtemp(join(scratch, "ws-")));
  await mkdir(runPaths(home, runId).root, { recursive: true });
  const owner = await startRunOwner({ home, runId, probeTimeoutMs: 250 });
  const history = () => parseEventLog(readFileSync(owner.paths.events, "utf8"));
  const adapters = fakeHarnessAdapters(script);
  const seen: HarnessActivity[] = [];

  async function call(
    attemptId: AttemptId,
    stepId: string,
    prompt = "the prompt",
    harness: "claude" | "pi" = "claude",
  ) {
    const attempt = await createAttemptDirectory(owner.paths.attempts, attemptId);
    await owner.events.append({ type: "attempt.started", attemptId, stepId, processGroupId: 1 });
    const get = dataGetHandler({
      events: owner.events,
      attemptsFolder: owner.paths.attempts,
      inputsFolder: owner.paths.inputs,
      history,
    });
    const put = dataPutHandler({
      events: owner.events,
      attemptsFolder: owner.paths.attempts,
      history,
    });
    const result = resultHandler({ events: owner.events, allowedOutcomes: ["done"], history });
    const endpoint = await owner.serveAttempt({
      socketPath: attempt.socket,
      current: () => ({ attemptId, secret: "s3cret" }),
      handle: (c) => (c.argv[0] === "result" ? result(c) : c.argv[1] === "get" ? get(c) : put(c)),
    });
    const context: ExecutionContext = {
      runId,
      attemptId,
      stepId,
      workspace,
      scratch: attempt.scratch,
      endpoint: attempt.socket,
      attemptSecret: "s3cret",
    };
    const harnessCall: HarnessCall = { context, prompt, args: [], wiringFolder: attempt.wiring };
    const started = await startHarnessCall(executor, adapters[harness], harnessCall, attempt, (a) =>
      seen.push(a),
    );
    assert.equal(started.kind, "running", JSON.stringify(started));
    const running = started as Extract<typeof started, { kind: "running" }>;
    return {
      attempt,
      running,
      end: running.ended.finally(() => endpoint.close()),
    };
  }

  const events = () => history();
  const close = () => owner.close();
  return { call, events, close, workspace, seen };
}

/** Runs the script's first call of `work` and returns the rig and how it ended. */
async function runOne(actions: readonly FakeAction[], prompt?: string) {
  const rig = await newRig({ work: [actions] });
  const run = await rig.call("001-work", "work", prompt);
  const end = await run.end;
  await rig.close();
  return { rig, run, end };
}

test("write makes parent folders and the exact content", async () => {
  const { rig, end } = await runOne([{ do: "write", path: "a/b/c.txt", content: "héllo\n" }]);
  assert.deepEqual(end, { kind: "exited", code: 0 });
  assert.equal(await readFile(join(rig.workspace, "a/b/c.txt"), "utf8"), "héllo\n");
});

test("activity reaches onActivity in order; null stays null and 0 stays 0", async () => {
  const metrics = {
    inputTokens: 0,
    outputTokens: 7,
    totalTokens: null,
    costUsd: null,
    toolCalls: 1,
    permissionDenials: null,
  };
  const { rig } = await runOne([
    { do: "activity", activity: { kind: "tool", tool: "edit", target: "a.ts" } },
    { do: "activity", activity: { kind: "progress", text: "working" } },
    { do: "activity", activity: { kind: "metrics", metrics } },
  ]);
  assert.deepEqual(rig.seen, [
    { kind: "tool", tool: "edit", target: "a.ts" },
    { kind: "progress", text: "working" },
    { kind: "metrics", metrics },
  ]);
  const last = rig.seen[2];
  assert.ok(last?.kind === "metrics");
  assert.equal(last.metrics.costUsd, null);
  assert.equal(last.metrics.inputTokens, 0);
});

test("dataPut in attempt 1 and dataGet in attempt 2 keep the exact bytes", async () => {
  const content = "line one\nnaïve — 日本語\n";
  const rig = await newRig({
    impl: [
      [{ do: "dataPut", key: "impl.k", content }],
      [{ do: "dataGet", key: "impl.k", to: "got/k.txt" }],
    ],
  });
  assert.deepEqual(await (await rig.call("001-impl", "impl")).end, { kind: "exited", code: 0 });
  assert.deepEqual(await (await rig.call("002-impl", "impl")).end, { kind: "exited", code: 0 });
  await rig.close();
  const got = await readFile(join(rig.workspace, "got/k.txt"));
  assert.deepEqual(got, Buffer.from(content, "utf8"));
});

test("an expected dataGet refusal writes no file and later actions still run", async () => {
  const { rig, end } = await runOne([
    { do: "dataGet", key: "missing", to: "never.txt", expectFailure: true },
    { do: "write", path: "after.txt", content: "x" },
  ]);
  assert.deepEqual(end, { kind: "exited", code: 0 });
  assert.deepEqual((await readdir(rig.workspace)).sort(), ["after.txt"]);
});

test("an unexpected dataGet refusal fails the fake and preserves CLI output", async () => {
  const { run, end } = await runOne([{ do: "dataGet", key: "missing", to: "never.txt" }]);
  assert.deepEqual(end, { kind: "exited", code: 97 });
  assert.match(await readFile(run.attempt.stderr, "utf8"), /no data key "missing"/);
});

test("an unexpected dataPut refusal fails the fake", async () => {
  const { end } = await runOne([{ do: "dataPut", key: "other.value", content: "x" }]);
  assert.deepEqual(end, { kind: "exited", code: 97 });
});

test("an unexpected result refusal fails the fake", async () => {
  const { end } = await runOne([{ do: "result", outcome: "not-allowed" }]);
  assert.deepEqual(end, { kind: "exited", code: 97 });
});

test("result gives one outcome.reported with the attempt ID; no result action gives none", async () => {
  const withResult = await runOne([{ do: "result", outcome: "done" }]);
  assert.deepEqual(withResult.end, { kind: "exited", code: 0 });
  const reported = withResult.rig.events().filter((e) => e.type === "outcome.reported");
  assert.equal(reported.length, 1);
  assert.ok(reported[0]?.type === "outcome.reported");
  assert.equal(reported[0].outcome, "done");
  assert.equal(reported[0].attemptId, "001-work");

  const without = await runOne([{ do: "write", path: "x", content: "y" }]);
  assert.deepEqual(without.end, { kind: "exited", code: 0 });
  assert.equal(without.rig.events().filter((e) => e.type === "outcome.reported").length, 0);
});

test("exit gives that code and later actions do not run", async () => {
  const { rig, end } = await runOne([
    { do: "exit", code: 3 },
    { do: "write", path: "late.txt", content: "x" },
  ]);
  assert.deepEqual(end, { kind: "exited", code: 3 });
  assert.deepEqual(await readdir(rig.workspace), []);
});

test("cancel stops a 60 s sleep as signalled in under 5 s", async () => {
  const rig = await newRig({ work: [[{ do: "sleep", ms: 60_000 }]] });
  const run = await rig.call("001-work", "work");
  const started = Date.now();
  await run.running.cancel();
  const end = await run.end;
  await rig.close();
  assert.equal(end.kind, "signalled");
  assert.ok(Date.now() - started < 5000);
});

test("savePrompt keeps a multi-line prompt exactly", async () => {
  const prompt = "first\n\nsecond line\n  third — é\n";
  const { rig } = await runOne([{ do: "savePrompt", path: "p.txt" }], prompt);
  assert.equal(await readFile(join(rig.workspace, "p.txt"), "utf8"), prompt);
});

test("a call past the scripted calls throws, and so does an unknown step", () => {
  const fake = fakeHarness({ impl: [[], []] });
  const call = (stepId: string): HarnessCall => ({
    context: { stepId } as ExecutionContext,
    prompt: "p",
    args: [],
    wiringFolder: "/w",
  });
  fake.prepare(call("impl"));
  fake.prepare(call("impl"));
  assert.throws(() => fake.prepare(call("impl")), /step impl has no scripted call 3/);
  assert.throws(() => fake.prepare(call("other")), /step other has no scripted call 1/);
});

test("claude and pi are one object and share the call count", () => {
  const adapters = fakeHarnessAdapters({
    impl: [[{ do: "exit", code: 1 }], [{ do: "exit", code: 2 }]],
  });
  assert.equal(adapters.claude, adapters.pi);
  const prepare = (harness: "claude" | "pi") =>
    adapters[harness].prepare({
      context: { stepId: "impl" } as ExecutionContext,
      prompt: "p",
      args: [],
      wiringFolder: "/w",
    });
  assert.equal(prepare("claude").wiringFiles["fake-call.json"], '[{"do":"exit","code":1}]');
  assert.equal(prepare("pi").wiringFiles["fake-call.json"], '[{"do":"exit","code":2}]');
});

test("fake-call.json is in the wiring folder and the workspace is clean", async () => {
  const { rig, run } = await runOne([{ do: "write", path: "only.txt", content: "x" }]);
  assert.equal(
    await readFile(join(run.attempt.wiring, "fake-call.json"), "utf8"),
    '[{"do":"write","path":"only.txt","content":"x"}]',
  );
  assert.deepEqual(await readdir(rig.workspace), ["only.txt"]);
});

test("stdout that is not an activity gives nothing and never throws", async () => {
  const { rig } = await runOne([{ do: "write", path: "x", content: "y" }]);
  assert.deepEqual(rig.seen, []);
  const line = (text: string) =>
    fakeHarness({ s: [[]] })
      .prepare({
        context: { stepId: "s" } as ExecutionContext,
        prompt: "",
        args: [],
        wiringFolder: "/w",
      })
      .parseStdoutLine(text);
  for (const text of [
    "",
    "text",
    "{",
    "null",
    "3",
    '"tool"',
    "[]",
    '{"kind":"other"}',
    '{"kind":1}',
  ]) {
    assert.deepEqual(line(text), [], text);
  }
});

test("no file in src outside a test file imports the fake", async () => {
  // Not `git ls-files`: Stryker runs the tests in a copy with no git folder.
  const src = join(import.meta.dirname, "..");
  const files = (await readdir(src, { recursive: true })).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(!readFileSync(join(src, file), "utf8").includes("fake-harness"), file);
  }
});
