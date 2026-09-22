import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecutionContext, RunningProcess, StartResult } from "../application/executor.ts";
import { localExecutor } from "./local-executor.ts";

/** A launch environment with only what finding a program needs. */
const LAUNCH: NodeJS.ProcessEnv = { PATH: process.env.PATH };

/** Every folder the tests make, removed once they all end. */
const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "loopfile-exec-")));
  folders.push(path);
  return path;
}

function contextIn(path: string): ExecutionContext {
  return {
    runId: "2026-09-18-0001",
    attemptId: "003-tests",
    stepId: "tests",
    workspace: path,
    scratch: join(path, "scratch"),
    endpoint: join(path, "sock"),
    attemptSecret: "s3cret",
  };
}

async function sh(line: string, env: NodeJS.ProcessEnv = {}, grace?: number): Promise<StartResult> {
  const executor = localExecutor({ ...LAUNCH, ...env }, grace);
  return executor.start({
    command: "sh",
    args: ["-c", line],
    context: contextIn(await workspace()),
  });
}

function running(result: StartResult): RunningProcess {
  assert.equal(result.kind, "running", JSON.stringify(result));
  return result as RunningProcess;
}

async function read(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += Buffer.from(chunk).toString();
  return text;
}

/** True while any process with this ID exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

test("stdout and stderr stream on separate pipes, and the exit code is reported", async () => {
  const started = running(await sh("echo out; echo err >&2; exit 3"));
  const [out, err, ended] = await Promise.all([
    read(started.stdout),
    read(started.stderr),
    started.ended,
  ]);
  assert.equal(out, "out\n");
  assert.equal(err, "err\n");
  assert.deepEqual(ended, { kind: "exited", code: 3 });
});

test("argument boundaries are kept, spaces and quotes included", async () => {
  const executor = localExecutor(LAUNCH);
  const started = running(
    await executor.start({
      command: "printf",
      args: ["[%s]", "two words", "'q'", ""],
      context: contextIn(await workspace()),
    }),
  );
  assert.equal(await read(started.stdout), "[two words]['q'][]");
});

test("the process sees every LOOPFILE_* variable, over a launch value of the same name", async () => {
  const started = running(
    await sh("env | grep -E '^(LOOPFILE_|KEEP=)' | sort", {
      KEEP: "launch",
      LOOPFILE_STEP: "stale",
      LOOPFILE_ITERATION: "stale",
    }),
  );
  const lines = (await read(started.stdout)).trim().split("\n");
  assert.deepEqual(
    lines.map((line) => line.split("=")[0]),
    [
      "KEEP",
      "LOOPFILE_ATTEMPT_ID",
      "LOOPFILE_ATTEMPT_SECRET",
      "LOOPFILE_ENDPOINT",
      "LOOPFILE_PROTOCOL_VERSION",
      "LOOPFILE_RUN_ID",
      "LOOPFILE_SCRATCH",
      "LOOPFILE_STEP",
      "LOOPFILE_WORKSPACE",
    ],
  );
  assert.ok(lines.includes("KEEP=launch"));
  assert.ok(lines.includes("LOOPFILE_STEP=tests"));
  assert.equal(
    lines.some((line) => line.startsWith("LOOPFILE_ITERATION=")),
    false,
  );
});

test("the working directory is the workspace root", async () => {
  const path = await workspace();
  const executor = localExecutor(LAUNCH);
  const started = running(
    await executor.start({ command: "pwd", args: ["-P"], context: contextIn(path) }),
  );
  assert.equal((await read(started.stdout)).trim(), path);
});

test("stdin is closed, so a reader of it ends at once", async () => {
  const started = running(await sh("cat; echo done"));
  assert.equal(await read(started.stdout), "done\n");
});

test("stdin text is written to the process, then stdin is closed", async () => {
  const executor = localExecutor(LAUNCH);
  const started = running(
    await executor.start({
      command: "cat",
      args: [],
      stdin: "hello",
      context: contextIn(await workspace()),
    }),
  );
  assert.equal(await read(started.stdout), "hello");
  assert.deepEqual(await started.ended, { kind: "exited", code: 0 });
});

test("the process leads its own process group, and that group is reported", async () => {
  const started = running(await sh("ps -o pgid= -p $$"));
  const group = Number((await read(started.stdout)).trim());
  assert.equal(group, started.processGroupId);
  const ours = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString());
  assert.notEqual(group, ours);
});

test("cancel stops a group that ignores SIGTERM with SIGKILL, children included", async () => {
  const started = running(await sh("trap '' TERM; sleep 60 & echo $!; wait", {}, 200));
  const out = started.stdout[Symbol.asyncIterator]();
  const child = Number(
    Buffer.from((await out.next()).value)
      .toString()
      .trim(),
  );
  assert.ok(alive(child));

  started.cancel();
  started.cancel();

  assert.deepEqual(await started.ended, { kind: "signalled", signal: "SIGKILL" });
  await until(() => !alive(child));
  assert.equal(alive(child), false);
});

test("cancel ends a process that obeys SIGTERM with SIGTERM", async () => {
  const started = running(await sh("sleep 60", {}, 200));
  started.cancel();
  assert.deepEqual(await started.ended, { kind: "signalled", signal: "SIGTERM" });
});

test("cancel after the group is gone does nothing", async () => {
  const started = running(await sh("true", {}, 50));
  await started.ended;
  started.cancel();
  await new Promise((r) => setTimeout(r, 100));
});

test("a command that is not there is a failed start, not an exit code", async () => {
  const executor = localExecutor(LAUNCH);
  const result = await executor.start({
    command: "loopfile-no-such-command",
    args: [],
    context: contextIn(await workspace()),
  });
  assert.equal(result.kind, "start-failed");
  assert.equal(result.kind === "start-failed" && result.code, "ENOENT");
});

test("a missing workspace is a failed start", async () => {
  const executor = localExecutor(LAUNCH);
  const result = await executor.start({
    command: "sh",
    args: ["-c", "true"],
    context: contextIn(join(await workspace(), "gone")),
  });
  assert.equal(result.kind, "start-failed");
});
