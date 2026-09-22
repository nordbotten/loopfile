import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { HarnessAdapters } from "../application/harness.ts";
import { type AttemptIdentity, checkAttemptCall } from "../application/owner-protocol.ts";
import type { RunEvent } from "../domain/events.ts";
import type { RalphStep } from "../domain/model.ts";
import { createAttemptDirectory } from "./attempt-directory.ts";
import { dataFile } from "./data-store.ts";
import { localExecutor } from "./local-executor.ts";
import { type RalphStepEnd, type RalphStepResult, runRalphStep } from "./ralph-step.ts";

const executor = localExecutor({ PATH: process.env.PATH }, 200);

const step: RalphStep = {
  id: "loop",
  kind: "ralph",
  harness: "pi",
  promptFile: "prompts/loop.md",
  args: [],
  on: { done: "$success" },
  onFailure: "$failure",
  outputs: {},
  maxAttempts: 5,
  timeoutMs: 5000,
  maxIterations: 10,
};

/**
 * What an iteration does. `report` and `put` stand in for what the run owner
 * records when the fake process calls `loopfile result` and `loopfile data put`.
 */
interface Turn {
  readonly script?: string;
  readonly report?: string;
  readonly put?: string;
}

/** Every folder the tests make, removed once they all end. */
const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function run(
  turns: readonly Turn[],
  theStep: RalphStep = step,
  attemptNumber = 1,
  promptText = "keep going",
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-ralph-")));
  folders.push(root);
  await mkdir(join(root, "loopfile/prompts"), { recursive: true });
  await writeFile(join(root, "loopfile/prompts/loop.md"), promptText);
  const attemptId = `00${attemptNumber}-loop`;
  const attempt = await createAttemptDirectory(join(root, "attempts"), attemptId);
  const history: RunEvent[] = [];
  const push = (event: object) => {
    const stored = { ...event, seq: history.length + 1, at: "t" } as RunEvent;
    history.push(stored);
    return stored;
  };
  let calls = 0;
  const secrets: string[] = [];
  const currents: (AttemptIdentity | undefined)[] = [];
  const prompts: string[] = [];
  const seenArgs: (readonly string[])[] = [];
  const adapter = {
    prepare: (call: { prompt: string; args: readonly string[]; context: ExecutionContext }) => {
      seenArgs.push(call.args);
      const turn = turns[calls] ?? {};
      calls += 1;
      prompts.push(call.prompt);
      const iteration = calls;
      if (turn.report !== undefined) {
        push({ type: "outcome.reported", attemptId, iteration, outcome: turn.report });
      }
      if (turn.put !== undefined) {
        const key = `loop.${turn.put}`;
        const file = dataFile(join(root, "attempts"), attemptId, key);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${turn.put}-value`);
        push({ type: "data.put", attemptId, key, size: 1, digest: "d" });
      }
      return {
        command: "node",
        args: ["-e", turn.script ?? ""],
        wiringFiles: {},
        parseStdoutLine: () => [],
      };
    },
  };
  const adapters = { claude: adapter, pi: adapter } as unknown as HarnessAdapters;
  const context: ExecutionContext = {
    runId: "2026-09-18-0001",
    attemptId,
    stepId: "loop",
    workspace: root,
    scratch: attempt.scratch,
    endpoint: attempt.socket,
    attemptSecret: "unused",
  };
  const result = await runRalphStep(
    {
      executor,
      adapters,
      loopfileRoot: join(root, "loopfile"),
      attemptsFolder: join(root, "attempts"),
      inputsFolder: join(root, "inputs"),
      events: { append: async (event) => push(event) },
      history: () => history,
      onActivity: () => {},
      newSecret: () => {
        const secret = `secret-${secrets.length + 1}`;
        secrets.push(secret);
        return secret;
      },
      setCurrent: (identity) => currents.push(identity),
    },
    theStep,
    context,
    attempt,
  );
  return {
    result,
    history,
    attempt,
    secrets,
    currents,
    prompts,
    seenArgs,
    root,
    calls: () => calls,
  };
}

function ended(result: RalphStepResult): RalphStepEnd {
  assert.ok("result" in result, JSON.stringify(result));
  return result;
}

const types = (history: readonly RunEvent[]) => history.map((event) => event.type);

test("two iterations with no outcome, then done: three iterations and the outcome", async () => {
  const { result, history, prompts } = await run([{}, {}, { report: "done" }]);
  assert.deepEqual(result, {
    result: "success",
    reason: "outcome",
    outcome: "done",
    iterations: 3,
  });
  assert.deepEqual(
    history
      .filter((e) => e.type === "iteration.ended")
      .map((e) => (e as { reason: string }).reason),
    ["no_outcome", "no_outcome", "outcome"],
  );
  assert.deepEqual(prompts, ["keep going", "keep going", "keep going"]);
});

test("a step that never reports fails with iteration_limit after maxIterations", async () => {
  const { result, calls } = await run([], { ...step, maxIterations: 3 });
  assert.deepEqual(result, { result: "failure", reason: "iteration_limit", iterations: 3 });
  assert.equal(calls(), 3);
});

test("the default limit of 10 is the loaded step's own value", async () => {
  const { result } = await run([], step);
  assert.equal("iterations" in result && result.iterations, 10);
});

test("a timed-out iteration is stopped, counted, and a fresh one starts", async () => {
  const { result, history } = await run(
    [{ script: "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" }, { report: "done" }],
    // The timeout holds for every iteration. At 100 ms the second one could not
    // start and report on a loaded machine, and timed out too.
    { ...step, timeoutMs: 1000 },
  );
  assert.equal(ended(result).result, "success");
  const endedEvents = history.filter((e) => e.type === "iteration.ended") as { reason: string }[];
  assert.deepEqual(
    endedEvents.map((e) => e.reason),
    ["timeout", "outcome"],
  );
});

test("an outcome followed by a non-zero exit is ignored", async () => {
  const { result, history } = await run([
    { report: "done", script: "process.exit(1)" },
    { report: "done" },
  ]);
  assert.equal(result.iterations, 2);
  const endedEvents = history.filter((e) => e.type === "iteration.ended") as { reason: string }[];
  assert.deepEqual(
    endedEvents.map((e) => e.reason),
    ["nonzero_exit", "outcome"],
  );
});

test("an outcome that is not a key of on fails the attempt", async () => {
  const { result } = await run([{ report: "nope" }]);
  assert.deepEqual(result, {
    result: "failure",
    reason: "outcome_not_allowed",
    outcome: "nope",
    iterations: 1,
  });
});

test("each iteration has its own secret; an ended iteration's call is refused", async () => {
  const { secrets, currents } = await run([{}, { report: "done" }]);
  assert.deepEqual(secrets, ["secret-1", "secret-2"]);
  assert.deepEqual(currents, [
    { attemptId: "001-loop", secret: "secret-1", iteration: 1 },
    undefined,
    { attemptId: "001-loop", secret: "secret-2", iteration: 2 },
    undefined,
  ]);
  const now = currents[2] as AttemptIdentity;
  const stale = JSON.stringify({
    attemptId: "001-loop",
    secret: "secret-1",
    iteration: 1,
    argv: [],
  });
  const check = checkAttemptCall(stale, now);
  assert.equal(check.accepted, false);
  const fresh = JSON.stringify({
    attemptId: "001-loop",
    secret: "secret-2",
    iteration: 2,
    argv: [],
  });
  assert.equal(checkAttemptCall(fresh, now).accepted, true);
});

test("a file change of iteration 1 is there in iteration 2", async () => {
  const { result } = await run([
    { script: "require('fs').writeFileSync('marker','1')" },
    {
      script: "if(!require('fs').existsSync('marker'))process.exit(9)",
      report: "done",
    },
  ]);
  assert.equal(ended(result).result, "success");
  assert.equal(ended(result).reason, "outcome");
});

test("an output put in iteration 1 satisfies outputs when iteration 3 reports", async () => {
  const withOutput = { ...step, outputs: { plan: ["done"] } };
  const ok = await run([{ put: "plan" }, {}, { report: "done" }], withOutput);
  assert.equal(ok.result.reason, "outcome");
  const missing = await run([{}, {}, { report: "done" }], withOutput);
  assert.deepEqual(missing.result, {
    result: "failure",
    reason: "missing_output",
    outcome: "done",
    iterations: 3,
  });
});

test("outputs are not checked for an outcome that does not need them", async () => {
  const { result } = await run([{ report: "done" }], { ...step, outputs: { plan: ["other"] } });
  assert.equal(result.reason, "outcome");
});

test("each iteration has its events and raw output in its own folder", async () => {
  const { attempt, history } = await run([
    { script: "console.log('one')" },
    { script: "console.log('two');console.error('e2')", report: "done" },
  ]);
  assert.equal(await readFile(join(attempt.iterations, "01/stdout"), "utf8"), "one\n");
  assert.equal(await readFile(join(attempt.iterations, "02/stdout"), "utf8"), "two\n");
  assert.equal(await readFile(join(attempt.iterations, "02/stderr"), "utf8"), "e2\n");
  assert.equal(existsSync(join(attempt.iterations, "03")), false);
  assert.deepEqual(
    types(history).filter((t) => t.startsWith("iteration")),
    ["iteration.started", "iteration.ended", "iteration.started", "iteration.ended"],
  );
  const started = history.filter((e) => e.type === "iteration.started") as {
    iteration: number;
    attemptId: string;
    processGroupId: number;
  }[];
  assert.deepEqual(
    started.map((e) => [e.attemptId, e.iteration]),
    [
      ["001-loop", 1],
      ["001-loop", 2],
    ],
  );
  // Each iteration is its own process, so each has its own group.
  const [first, second] = started.map((e) => e.processGroupId);
  assert.ok((first ?? 0) > 0 && (second ?? 0) > 0 && first !== second, `${first} ${second}`);
});

test("a second attempt counts its iterations from 1 again", async () => {
  const { history } = await run([{ report: "done" }], step, 2);
  const started = history.find((e) => e.type === "iteration.started") as { iteration: number };
  assert.equal(started.iteration, 1);
});

test("a harness command that is not there is a failed start", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-ralph-")));
  folders.push(root);
  await mkdir(join(root, "loopfile/prompts"), { recursive: true });
  await writeFile(join(root, "loopfile/prompts/loop.md"), "x");
  const attempt = await createAttemptDirectory(join(root, "attempts"), "001-loop");
  const adapter = {
    prepare: () => ({
      command: "loopfile-no-such-command",
      args: [],
      wiringFiles: {},
      parseStdoutLine: () => [],
    }),
  };
  const result = await runRalphStep(
    {
      executor,
      adapters: { claude: adapter, pi: adapter } as unknown as HarnessAdapters,
      loopfileRoot: join(root, "loopfile"),
      attemptsFolder: join(root, "attempts"),
      inputsFolder: join(root, "inputs"),
      events: { append: async () => ({}) as RunEvent },
      history: () => [],
      onActivity: () => {},
      newSecret: () => "s",
      setCurrent: () => {},
    },
    step,
    {
      runId: "r",
      attemptId: "001-loop",
      stepId: "loop",
      workspace: root,
      scratch: attempt.scratch,
      endpoint: attempt.socket,
      attemptSecret: "s",
    },
    attempt,
  );
  assert.equal("reason" in result && result.reason, "start_failed");
});

test("an absolute promptFile is refused", async () => {
  await assert.rejects(run([], { ...step, promptFile: "/etc/passwd" }), /not relative/);
});

test("every iteration gets the step's args, unchanged", async () => {
  const args = ["--add-dir", "a dir", "{{ input.x }}", `it's "q"`];
  const { seenArgs } = await run([{}, {}, { report: "done" }], { ...step, args });
  assert.deepEqual(seenArgs, [args, args, args]);
});

test("iteration 2 gets the value iteration 1 put, and each iteration records its own fill", async () => {
  const { prompts, history } = await run(
    [{ put: "notes" }, { report: "done" }],
    step,
    1,
    "notes: [{{ loop.notes }}]",
  );
  assert.deepEqual(prompts, ["notes: []", "notes: [notes-value]"]);
  const fills = history.flatMap((event) => (event.type === "prompt.filled" ? [event] : []));
  assert.deepEqual(
    fills.map((fill) => [fill.iteration, fill.stepId, fill.keys]),
    [
      [1, "loop", { "loop.notes": false }],
      [2, "loop", { "loop.notes": true }],
    ],
  );
  assert.deepEqual(
    types(history)
      .filter((type) => type !== "data.put")
      .slice(0, 3),
    ["prompt.filled", "iteration.started", "iteration.ended"],
  );
});
