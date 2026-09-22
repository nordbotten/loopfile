import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Ended,
  ExecutionContext,
  Executor,
  RunningProcess,
  StartFailure,
  StartRequest,
  StartResult,
} from "./executor.ts";
import { CANCEL_GRACE_MS, CONTEXT_PROTOCOL_VERSION, contextEnvironment } from "./executor.ts";

/**
 * What one scripted process does: what it writes, and how it ends.
 *
 * `end` left out means it runs until it is cancelled, which is how a step that
 * hangs is written in a test. A `start-failed` end never runs at all.
 */
interface Script {
  readonly stdout?: readonly string[];
  readonly stderr?: readonly string[];
  readonly end?: Ended | StartFailure;
}

/** An executor plus what it was asked to start, so a caller can be checked. */
interface FakeExecutor extends Executor {
  readonly requests: StartRequest[];
}

/**
 * A scripted executor: the second implementation of the interface, so its
 * shape is not built around the local process one (ADR 0004).
 *
 * Scripts are used in order, one per `start`.
 */
function fakeExecutor(scripts: readonly Script[]): FakeExecutor {
  const requests: StartRequest[] = [];
  let index = 0;
  return {
    requests,
    async start(request: StartRequest): Promise<StartResult> {
      requests.push(request);
      const script = scripts[index++];
      if (script === undefined) throw new Error(`no script for start ${index}`);
      const end = script.end;
      if (end?.kind === "start-failed") return end;
      return scriptedProcess(script, end, 1000 + index);
    },
  };
}

function scriptedProcess(
  script: Script,
  end: Ended | undefined,
  processGroupId: number,
): RunningProcess {
  let settle: ((ended: Ended) => void) | undefined;
  const ended = new Promise<Ended>((resolve) => {
    if (end === undefined) settle = resolve;
    else resolve(end);
  });
  return {
    kind: "running",
    processGroupId,
    ended,
    stdout: chunks(script.stdout ?? []),
    stderr: chunks(script.stderr ?? []),
    /** The real executor signals the group; here the process just ends as if it had. */
    cancel(): void {
      settle?.({ kind: "signalled", signal: "SIGTERM" });
      settle = undefined;
    },
  };
}

async function* chunks(lines: readonly string[]): AsyncIterable<Uint8Array> {
  for (const line of lines) yield new TextEncoder().encode(line);
}

async function read(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += new TextDecoder().decode(chunk);
  return text;
}

const context: ExecutionContext = {
  runId: "2026-09-18-0001",
  attemptId: "007-fix",
  stepId: "fix",
  workspace: "/w",
  scratch: "/w/.scratch",
  endpoint: "/runs/r/attempts/007-fix/sock",
  attemptSecret: "s3cret",
};

function request(command: string, ...args: string[]): StartRequest {
  return { command, args, context };
}

test("a started process reports its group and streams both pipes", async () => {
  const executor = fakeExecutor([
    { stdout: ["one ", "two"], stderr: ["warn"], end: { kind: "exited", code: 0 } },
  ]);

  const started = await executor.start(request("sh", "-e", "-c", "echo one two"));
  assert.equal(started.kind, "running");
  assert.ok(started.processGroupId > 0);
  assert.equal(await read(started.stdout), "one two");
  assert.equal(await read(started.stderr), "warn");
  assert.deepEqual(await started.ended, { kind: "exited", code: 0 });
});

test("the request reaches the executor with argument boundaries and context kept", async () => {
  const executor = fakeExecutor([{ end: { kind: "exited", code: 0 } }]);

  await executor.start(request("git", "commit", "-m", "two words"));

  assert.deepEqual(executor.requests[0]?.args, ["commit", "-m", "two words"]);
  assert.equal(executor.requests[0]?.context, context);
});

test("an exit code, an exit by signal and a failed start are three different results", async () => {
  const executor = fakeExecutor([
    { end: { kind: "exited", code: 1 } },
    { end: { kind: "signalled", signal: "SIGKILL" } },
    { end: { kind: "start-failed", message: "spawn nope ENOENT", code: "ENOENT" } },
  ]);

  const exited = await executor.start(request("false"));
  const signalled = await executor.start(request("sleep", "60"));
  const failed = await executor.start(request("nope"));

  assert.equal(exited.kind, "running");
  assert.deepEqual(await exited.ended, { kind: "exited", code: 1 });
  assert.equal(signalled.kind, "running");
  assert.deepEqual(await signalled.ended, { kind: "signalled", signal: "SIGKILL" });
  assert.equal(failed.kind, "start-failed");
  assert.equal(failed.code, "ENOENT");
});

test("cancelling a process that would not end ends it by signal, and repeats safely", async () => {
  const executor = fakeExecutor([{ stdout: ["working"] }]);

  const started = await executor.start(request("sleep", "60"));
  assert.equal(started.kind, "running");
  started.cancel();
  started.cancel();

  assert.deepEqual(await started.ended, { kind: "signalled", signal: "SIGTERM" });
});

test("the cancel grace period is the ten seconds ADR 0008 fixes", () => {
  assert.equal(CANCEL_GRACE_MS, 10_000);
});

test("the context becomes the LOOPFILE_* variables ADR 0005 names, and nothing else", () => {
  assert.deepEqual(contextEnvironment(context), {
    LOOPFILE_RUN_ID: "2026-09-18-0001",
    LOOPFILE_ATTEMPT_ID: "007-fix",
    LOOPFILE_STEP: "fix",
    LOOPFILE_PROTOCOL_VERSION: "1",
    LOOPFILE_WORKSPACE: "/w",
    LOOPFILE_SCRATCH: "/w/.scratch",
    LOOPFILE_ENDPOINT: "/runs/r/attempts/007-fix/sock",
    LOOPFILE_ATTEMPT_SECRET: "s3cret",
  });
});

test("the context protocol is version 1", () => {
  assert.equal(CONTEXT_PROTOCOL_VERSION, 1);
});

test("a Ralph iteration's context also sets LOOPFILE_ITERATION", () => {
  const base = {
    runId: "r",
    attemptId: "001-loop",
    stepId: "loop",
    workspace: "/w",
    scratch: "/s",
    endpoint: "/e",
    attemptSecret: "x",
  };
  assert.equal(contextEnvironment({ ...base, iteration: 2 }).LOOPFILE_ITERATION, "2");
  assert.equal("LOOPFILE_ITERATION" in contextEnvironment(base), false);
});
