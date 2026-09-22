import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { HarnessAdapter, HarnessAdapters, HarnessCall } from "../application/harness.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AgentStep } from "../domain/model.ts";
import { type AgentStepStart, startAgentStep } from "./agent-step.ts";
import { createAttemptDirectory } from "./attempt-directory.ts";
import { localExecutor } from "./local-executor.ts";

const executor = localExecutor({ PATH: process.env.PATH }, 200);

const step: AgentStep = {
  id: "work",
  kind: "agent",
  harness: "pi",
  model: "m1",
  effort: "high",
  promptFile: "prompts/work.md",
  args: [],
  on: { done: "$success" },
  onFailure: "$failure",
  outputs: {},
  maxAttempts: 5,
  timeoutMs: 1000,
};

/** A scripted fake adapter behind a real name. It records the call it was given. */
function fake(script: string, calls: HarnessCall[]): HarnessAdapter {
  return {
    prepare: (call) => {
      calls.push(call);
      return {
        command: "node",
        args: ["-e", script],
        wiringFiles: {},
        parseStdoutLine: () => [],
      };
    },
  };
}

/** Every folder the tests make, removed once they all end. */
const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function run(script: string, reported: string | undefined, theStep: AgentStep = step) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-agent-")));
  folders.push(root);
  await mkdir(join(root, "loopfile/prompts"), { recursive: true });
  await writeFile(join(root, "loopfile/prompts/work.md"), "do the work");
  const attempt = await createAttemptDirectory(join(root, "attempts"), "001-work");
  const context: ExecutionContext = {
    runId: "2026-09-18-0001",
    attemptId: "001-work",
    stepId: "work",
    workspace: root,
    scratch: attempt.scratch,
    endpoint: attempt.socket,
    attemptSecret: "s3cret",
  };
  const calls: HarnessCall[] = [];
  const adapter = fake(script, calls);
  const adapters: HarnessAdapters = { claude: adapter, pi: adapter };
  const history: RunEvent[] = [];
  const started: AgentStepStart = await startAgentStep(
    {
      executor,
      adapters,
      loopfileRoot: join(root, "loopfile"),
      events: { append: async (event) => ({ ...event, seq: 1, at: "t" }) as RunEvent },
      attemptsFolder: join(root, "attempts"),
      inputsFolder: join(root, "inputs"),
      // The fake process cannot reach a real owner, so the report lands here, as the owner would.
      history: () => history,
      onActivity: () => {},
    },
    theStep,
    context,
    attempt,
  );
  assert.equal(started.kind, "running", JSON.stringify(started));
  const running = started as Extract<AgentStepStart, { kind: "running" }>;
  if (reported !== undefined) {
    history.push({
      type: "outcome.reported",
      attemptId: "001-work",
      outcome: reported,
      seq: 1,
      at: "t",
    } as unknown as RunEvent);
  }
  return { end: await running.ended, calls, attempt };
}

test("an outcome in on succeeds, and the harness got the prompt, model and effort", async () => {
  const { end, calls, attempt } = await run("console.log('hi')", "done");
  assert.deepEqual(end, {
    exit: { kind: "exited", code: 0 },
    outcome: "done",
    result: "success",
    reason: "outcome",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.prompt, "do the work");
  assert.equal(calls[0]?.model, "m1");
  assert.equal(calls[0]?.effort, "high");
  assert.equal(await readFile(attempt.stdout, "utf8"), "hi\n");
});

test("a clean exit with no outcome fails the attempt", async () => {
  const { end } = await run("", undefined);
  assert.equal(end.result, "failure");
  assert.equal(end.reason, "clean_exit");
  assert.equal(end.outcome, undefined);
});

test("an unknown outcome fails the attempt", async () => {
  const { end } = await run("", "nope");
  assert.equal(end.result, "failure");
  assert.equal(end.reason, "outcome_not_allowed");
  assert.equal(end.outcome, "nope");
});

test("a non-zero exit fails the attempt and stderr is kept", async () => {
  const { end, attempt } = await run("console.error('bad'); process.exit(3)", "done");
  assert.deepEqual(end.exit, { kind: "exited", code: 3 });
  assert.equal(end.reason, "nonzero_exit");
  assert.equal(await readFile(attempt.stderr, "utf8"), "bad\n");
});

test("the outcome is not read from harness output", async () => {
  const { end } = await run("console.log('outcome: done')", undefined);
  assert.equal(end.result, "failure");
  assert.equal(end.outcome, undefined);
});

test("a model and effort left out are not passed", async () => {
  const { model: _m, effort: _e, ...bare } = step;
  const { calls } = await run("", undefined, bare);
  assert.equal("model" in (calls[0] ?? {}), false);
  assert.equal("effort" in (calls[0] ?? {}), false);
});

test("a harness command that is not there is a failed start", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-agent-")));
  folders.push(root);
  await mkdir(join(root, "loopfile/prompts"), { recursive: true });
  await writeFile(join(root, "loopfile/prompts/work.md"), "x");
  const attempt = await createAttemptDirectory(join(root, "attempts"), "001-work");
  const adapter: HarnessAdapter = {
    prepare: () => ({
      command: "loopfile-no-such-command",
      args: [],
      wiringFiles: {},
      parseStdoutLine: () => [],
    }),
  };
  const started = await startAgentStep(
    {
      executor,
      adapters: { claude: adapter, pi: adapter },
      loopfileRoot: join(root, "loopfile"),
      events: { append: async (event) => ({ ...event, seq: 1, at: "t" }) as RunEvent },
      attemptsFolder: join(root, "attempts"),
      inputsFolder: join(root, "inputs"),
      history: () => [],
      onActivity: () => {},
    },
    step,
    {
      runId: "r",
      attemptId: "001-work",
      stepId: "work",
      workspace: root,
      scratch: attempt.scratch,
      endpoint: attempt.socket,
      attemptSecret: "s",
    },
    attempt,
  );
  assert.equal(started.kind, "start-failed");
  assert.equal("reason" in started && started.reason, "start_failed");
});

test("an absolute promptFile is refused", async () => {
  await assert.rejects(run("", undefined, { ...step, promptFile: "/etc/passwd" }), /not relative/);
});

test("the harness gets the step's args in order, one string each, unchanged", async () => {
  const args = ["--max-budget-usd", "10", "a b", `it's "q"`, "{{ input.x }}"];
  const { calls } = await run("", "done", { ...step, args });
  assert.deepEqual(calls[0]?.args, args);
});
