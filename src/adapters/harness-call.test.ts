import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type {
  HarnessActivity,
  HarnessAdapter,
  HarnessCall,
  PreparedHarnessCall,
} from "../application/harness.ts";
import { createAttemptDirectory } from "./attempt-directory.ts";
import { type HarnessCallStart, startHarnessCall } from "./harness-call.ts";
import { localExecutor } from "./local-executor.ts";

const executor = localExecutor({ PATH: process.env.PATH }, 200);

/** A scripted adapter that runs `node -e script`, with every other field overridable. */
function adapter(script: string, extra: Partial<PreparedHarnessCall> = {}): HarnessAdapter {
  return {
    prepare: () => ({
      command: "node",
      args: ["-e", script],
      wiringFiles: {},
      parseStdoutLine: (line) => [{ kind: "progress", text: line }],
      ...extra,
    }),
  };
}

/** Every folder the tests make, removed once they all end. */
const folders: string[] = [];
test.after(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-harness-")));
  folders.push(root);
  const attempt = await createAttemptDirectory(join(root, "attempts"), "001-agent");
  const context: ExecutionContext = {
    runId: "2026-09-18-0001",
    attemptId: "001-agent",
    stepId: "agent",
    workspace: root,
    scratch: attempt.scratch,
    endpoint: attempt.socket,
    attemptSecret: "s3cret",
  };
  const call: HarnessCall = {
    context,
    prompt: "the prompt",
    args: [],
    wiringFolder: attempt.wiring,
  };
  return { root, attempt, call };
}

async function run(
  script: string,
  extra: Partial<PreparedHarnessCall> = {},
  callExtra: Partial<HarnessCall> = {},
) {
  const { root, attempt, call } = await setup();
  const seen: HarnessActivity[] = [];
  const started = await startHarnessCall(
    executor,
    adapter(script, extra),
    { ...call, ...callExtra },
    attempt,
    (activity) => seen.push(activity),
  );
  return { root, attempt, started, seen };
}

function running(started: HarnessCallStart) {
  assert.equal(started.kind, "running", JSON.stringify(started));
  return started as Extract<HarnessCallStart, { kind: "running" }>;
}

const texts = (seen: readonly HarnessActivity[]) =>
  seen.map((a) => (a.kind === "progress" ? a.text : a.kind));

test("wiring files appear in the wiring folder and the workspace gets none", async () => {
  const { root, attempt, started } = await run("", { wiringFiles: { "a.json": "{}", b: "x" } });
  await running(started).ended;
  assert.equal(await readFile(join(attempt.wiring, "a.json"), "utf8"), "{}");
  assert.equal(await readFile(join(attempt.wiring, "b"), "utf8"), "x");
  assert.deepEqual(await readdir(root), ["attempts"]);
});

test("a bad wiring file name rejects the call and no process starts", async () => {
  for (const name of ["../x", "a/b", "..", "."]) {
    const { root, attempt, call } = await setup();
    const marker = join(root, "started");
    await assert.rejects(
      startHarnessCall(
        executor,
        adapter(`require("fs").writeFileSync(${JSON.stringify(marker)}, "")`, {
          wiringFiles: { [name]: "x" },
        }),
        call,
        attempt,
        () => {},
      ),
      /plain file name/,
    );
    assert.deepEqual(await readdir(root), ["attempts"], name);
  }
});

test("the child gets args in order and the prompt on stdin, not in argv", async () => {
  const { attempt, started } = await run(
    `process.stdin.pipe(process.stdout); process.stderr.write(JSON.stringify(process.argv.slice(1)))`,
    {
      args: [
        "-e",
        "process.stdin.pipe(process.stdout); process.stderr.write(JSON.stringify(process.argv.slice(1)))",
        "a b",
        "--x=1",
      ],
      stdin: "the prompt",
    },
  );
  await running(started).ended;
  assert.equal(await readFile(attempt.stdout, "utf8"), "the prompt");
  const argv = JSON.parse(await readFile(attempt.stderr, "utf8"));
  assert.deepEqual(argv, ["a b", "--x=1"]);
  assert.ok(!argv.some((a: string) => a.includes("the prompt")));
});

test("stdout lines become activity in order, split lines once, last line without newline", async () => {
  const { started, seen } = await run(
    `process.stdout.write("one\\ntw"); setTimeout(() => process.stdout.write("o\\nlast"), 50)`,
  );
  await running(started).ended;
  assert.deepEqual(texts(seen), ["one", "two", "last"]);
});

test("a multi-byte character split across chunks is read whole", async () => {
  const { started, seen } = await run(
    `const b = Buffer.from("é\\n"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)`,
  );
  await running(started).ended;
  assert.deepEqual(texts(seen), ["é"]);
});

test("metrics keep null as null and 0 as 0", async () => {
  const metrics = {
    inputTokens: null,
    outputTokens: 0,
    totalTokens: null,
    costUsd: 0,
    toolCalls: null,
    permissionDenials: null,
  };
  const { started, seen } = await run(`console.log("m")`, {
    parseStdoutLine: () => [{ kind: "metrics", metrics }],
  });
  await running(started).ended;
  assert.deepEqual(seen, [{ kind: "metrics", metrics }]);
});

test("a parser that throws on one line does not stop the lines after it", async () => {
  const { started, seen } = await run(`console.log("a\\nbad\\nc")`, {
    parseStdoutLine: (line) => {
      if (line === "bad") throw new Error("boom");
      return [{ kind: "progress", text: line }];
    },
  });
  await running(started).ended;
  assert.deepEqual(texts(seen), ["a", "c"]);
});

test("stdout and stderr files hold the exact bytes", async () => {
  const { attempt, started } = await run(
    `process.stdout.write(Buffer.from([0xff, 0x0a, 0x00, 0x41])); process.stderr.write("err\\r\\n")`,
  );
  await running(started).ended;
  assert.deepEqual([...(await readFile(attempt.stdout))], [0xff, 0x0a, 0x00, 0x41]);
  assert.equal(await readFile(attempt.stderr, "utf8"), "err\r\n");
});

test("exit code 3 is reported as exited 3", async () => {
  const { started } = await run("process.exit(3)");
  assert.deepEqual(await running(started).ended, { kind: "exited", code: 3 });
});

test("a missing command is start_failed with ENOENT", async () => {
  const { started } = await run("", { command: "loopfile-no-such-command" });
  assert.equal(started.kind, "start-failed");
  assert.equal((started as { reason: string }).reason, "start_failed");
  assert.equal((started as { code?: string }).code, "ENOENT");
});

test("cancel ends a sleeping child with signalled", async () => {
  const { started } = await run("setTimeout(() => {}, 60000)");
  const child = running(started);
  child.cancel();
  assert.equal((await child.ended).kind, "signalled");
});
