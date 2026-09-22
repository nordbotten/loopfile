import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPaths } from "./run-directory.ts";
import { tailCommand } from "./tail-command.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-tail-"));
let counter = 0;

/** A `run.ended` line for a run that completed: the end `tail` exits 0 on. */
function endEvent(seq: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "run.ended",
    seq,
    at: "x",
    result: "success",
    reason: "end_state",
    ...overrides,
  });
}

/** A fresh home and run ID, with nothing on disk yet. */
function newRun(): { home: string; runId: string } {
  counter += 1;
  return { home: join(scratch, `home-${counter}`), runId: `20260917-160344-t${counter}` };
}

/** Captures what a run of `tailCommand` printed and returns. */
function capture(): {
  out: (text: string) => void;
  err: (text: string) => void;
  lines(): string[];
  errText(): string;
} {
  let outText = "";
  let errText = "";
  return {
    out: (text) => {
      outText += text;
    },
    err: (text) => {
      errText += text;
    },
    lines: () => (outText === "" ? [] : outText.split("\n").slice(0, -1)),
    errText: () => errText,
  };
}

/** A fake control socket that answers a ping with `runId`, or refuses to bind at all. */
async function fakeOwner(socketPath: string, runId: string): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.includes("\n")) socket.write(`${JSON.stringify({ type: "pong", runId })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("tail on an unknown run gives a clear error and exits 2", async () => {
  const { home, runId } = newRun();
  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 2);
  assert.match(out.errText(), /unknown run/);
  assert.match(out.errText(), new RegExp(runId));
});

test("tail on a run with no activity log gives a clear error and exits 2", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 2);
  assert.match(out.errText(), /no activity log/);
});

test("tail on an ended run prints the last lines and exits 0, with no owner needed", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  const lines = Array.from({ length: 15 }, (_, i) => `00:00:0${i % 10} line ${i}`);
  await writeFile(paths.activity, lines.map((line) => `${line}\n`).join(""));
  await writeFile(
    paths.events,
    `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n${endEvent(2)}\n`,
  );

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 0);
  assert.deepEqual(out.lines(), lines.slice(-10));
});

test("tail --json prints terminal metrics", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "ignored\n");
  await writeFile(
    paths.events,
    `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n${endEvent(2, {
      metrics: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        toolCalls: null,
        permissionDenials: 3,
      },
    })}\n`,
  );

  const out = capture();
  const code = await tailCommand(["tail", runId, "--json"], out.out, out.err, {
    LOOPFILE_HOME: home,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.lines()[1] ?? "{}").metrics.permissionDenials, 3);
});

test("tail on an ended run never prints a half-written trailing line", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  // The last line has no trailing newline yet: a write still in flight.
  await writeFile(paths.activity, "one\ntwo\nthree");
  await writeFile(paths.events, `${endEvent(1)}\n`);

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 0);
  assert.deepEqual(out.lines(), ["one", "two"]);
});

test("tail prints fewer than 10 lines when the log has fewer", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "one\ntwo\n");
  await writeFile(paths.events, `${endEvent(1)}\n`);

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 0);
  assert.deepEqual(out.lines(), ["one", "two"]);
});

test("tail follows new activity lines and exits 0 soon after the run ends", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);

  const owner = await fakeOwner(paths.socket, runId);
  const out = capture();
  const promise = tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    {
      pollIntervalMs: 20,
      ownerPingTimeoutMs: 200,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  await appendFile(paths.activity, "more\n");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await appendFile(paths.events, `${endEvent(2)}\n`);

  const code = await promise;
  await owner.close();

  assert.equal(code, 0);
  assert.deepEqual(out.lines(), ["start", "more"]);
});

test("tail flushes the final activity line written together with the end event, between polls", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);

  const owner = await fakeOwner(paths.socket, runId);
  const out = capture();
  let wroteBetweenPolls = false;
  const code = await tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    {
      pollIntervalMs: 20,
      ownerPingTimeoutMs: 200,
      // Fires between the loop's first poll (found nothing to stop for) and
      // its second: the run owner writes its last activity line and its end
      // event right next to each other, the way a real run owner does, and
      // both must still reach `out` before `tail` exits.
      sleep: async (ms) => {
        if (!wroteBetweenPolls) {
          wroteBetweenPolls = true;
          await appendFile(paths.activity, "last line\n");
          await appendFile(paths.events, `${endEvent(2)}\n`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
  );
  await owner.close();

  assert.equal(code, 0);
  assert.deepEqual(out.lines(), ["start", "last line"]);
});

test("tail still sees the end event when its line is written in two pieces", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);

  const owner = await fakeOwner(paths.socket, runId);
  const out = capture();
  const promise = tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 200 },
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  const line = endEvent(2);
  // Write the end event line in two pieces, straddling at least one poll, the
  // way a torn or buffered write could land on disk.
  await appendFile(paths.events, line.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await appendFile(paths.events, `${line.slice(10)}\n`);

  const code = await promise;
  await owner.close();

  assert.equal(code, 0);
});

test("tail still sees the end event when its line was half-written before tail started", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  const line = endEvent(2);
  // The first piece is already on disk when `tail` opens the file: the torn
  // write it has to hold back is the very first thing it reads.
  await writeFile(
    paths.events,
    `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n${line.slice(0, 10)}`,
  );

  const owner = await fakeOwner(paths.socket, runId);
  const out = capture();
  const promise = tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 200 },
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  await appendFile(paths.events, `${line.slice(10)}\n`);

  const code = await promise;
  await owner.close();

  assert.equal(code, 0);
});

/** A control socket that accepts a connection and never answers, so a ping against it always times out. */
async function silentOwner(socketPath: string): Promise<{ close(): Promise<void> }> {
  const open = new Set<import("node:net").Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test("tail does not report the owner gone when it ended just as the ping failed", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);

  // The socket answers nothing, so the first poll's ping times out. While it
  // is timing out, the run writes its end event and the owner would, in a
  // real run, then close the socket — the gap this test is closing.
  const owner = await silentOwner(paths.socket);
  const out = capture();
  const promise = tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 100 },
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  await appendFile(paths.events, `${endEvent(2)}\n`);

  const code = await promise;
  await owner.close();

  assert.equal(code, 0);
});

test("tail exits 2 when the run owner is gone with no end event", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);
  // No socket file at all: nothing answers.

  const out = capture();
  const code = await tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    {
      pollIntervalMs: 20,
      ownerPingTimeoutMs: 200,
    },
  );

  assert.equal(code, 2);
  assert.match(out.errText(), /run owner/);
  assert.match(out.errText(), new RegExp(runId));
});

test("tail still prints a final line written just before a truly gone owner is reported", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);

  // The socket answers nothing, so the first poll's ping times out. While it
  // is timing out, the run owner writes one last line and then really does
  // crash: no end event ever follows.
  const owner = await silentOwner(paths.socket);
  const out = capture();
  const promise = tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 100 },
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  await appendFile(paths.activity, "last line\n");

  const code = await promise;
  await owner.close();

  assert.equal(code, 2);
  assert.deepEqual(out.lines(), ["start", "last line"]);
});

test("tail writes no run file", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${endEvent(1)}\n`);

  const before = (await readdir(paths.root)).sort();
  const beforeStats = await Promise.all(before.map((name) => stat(join(paths.root, name))));

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 0);

  const after = (await readdir(paths.root)).sort();
  assert.deepEqual(after, before);
  const afterStats = await Promise.all(after.map((name) => stat(join(paths.root, name))));
  for (const [i, name] of before.entries()) {
    assert.equal(afterStats[i]?.mtimeMs, beforeStats[i]?.mtimeMs, `${name} was not modified`);
  }
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("tail on a run that already failed exits 1 and writes the end text to stderr", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(
    paths.events,
    `${endEvent(1, { result: "failure", reason: "attempt_limit", stepId: "review" })}\n`,
  );

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 1);
  assert.deepEqual(out.lines(), ["start"]);
  assert.equal(
    out.errText(),
    `run ${runId} failed: attempt_limit at step "review"\n` +
      `  see: loopfile logs ${runId}\n` +
      `       loopfile status ${runId} --json\n`,
  );
});

test("tail on a run that already completed exits 0 and writes nothing to stderr", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${endEvent(1)}\n`);

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 0);
  assert.equal(out.errText(), "");
});

test("tail on a cancelled run exits 1", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.cancelled", seq: 1, at: "x" })}\n`);

  const out = capture();
  const code = await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home });
  assert.equal(code, 1);
  assert.match(out.errText(), new RegExp(`^run ${runId} cancelled: cancelled\n`));
});

test("tail following a run that fails exits 1 with the end text, and prints no end text on stdout", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${JSON.stringify({ type: "run.created", seq: 1, at: "x" })}\n`);
  const owner = await fakeOwner(paths.socket, runId);

  const out = capture();
  const promise = tailCommand(
    ["tail", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 200 },
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  await appendFile(paths.activity, "last line\n");
  await appendFile(
    paths.events,
    `${endEvent(2, { result: "failure", reason: "internal_error" })}\n`,
  );

  const code = await promise;
  await owner.close();

  assert.equal(code, 1);
  assert.deepEqual(out.lines(), ["start", "last line"]);
  assert.match(out.errText(), new RegExp(`^error: run ${runId} failed: internal_error\n`));
});

test("tail puts the last 20 owner log lines in help for an internal error", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(
    paths.events,
    `${endEvent(1, { result: "failure", reason: "internal_error" })}\n`,
  );
  await writeFile(paths.ownerLog, Array.from({ length: 21 }, (_, i) => `line ${i}`).join("\n"));

  const out = capture();
  assert.equal(await tailCommand(["tail", runId], out.out, out.err, { LOOPFILE_HOME: home }), 1);
  assert.match(out.errText(), /^error: run .* failed: internal_error\ncode: operation_failed\n/);
  assert.match(out.errText(), /help: "End of .*owner\.log:\\nline 1/);
  assert.match(out.errText(), /\\nline 20"\n$/);
  assert.doesNotMatch(out.errText(), /line 0/);
});

const created = JSON.stringify({ type: "run.created", seq: 1, at: "x" });

test("tail --json on an ended run prints every event through the end, and no activity", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  const ended = endEvent(2, { result: "failure", reason: "attempt_limit" });
  await writeFile(paths.events, `${created}\n${ended}\n{"type":"late"}\n`);

  const out = capture();
  const code = await tailCommand(["tail", runId, "--json"], out.out, out.err, {
    LOOPFILE_HOME: home,
  });
  assert.equal(code, 1);
  assert.deepEqual(out.lines(), [created, ended]);
  assert.match(out.errText(), /failed: attempt_limit/);
});

test("tail --json follows new events, holds back a half-written one and exits 0 at the end", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${created}\n`);

  const owner = await fakeOwner(paths.socket, runId);
  const out = capture();
  const promise = tailCommand(
    ["tail", "--json", runId],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 200 },
  );

  const started = JSON.stringify({ type: "attempt.started", seq: 2, at: "x" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await appendFile(paths.activity, "more\n");
  await appendFile(paths.events, started.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(out.lines(), [created]);
  await appendFile(paths.events, `${started.slice(10)}\n${endEvent(3)}\n`);

  const code = await promise;
  await owner.close();

  assert.equal(code, 0);
  assert.deepEqual(out.lines(), [created, started, endEvent(3)]);
  assert.equal(out.errText(), "");
});

test("tail --json exits 2 when the run owner is gone, and never prints the half-written line", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${created}\n{"type":"attem`);

  const out = capture();
  const code = await tailCommand(
    ["tail", runId, "--json"],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 200 },
  );

  assert.equal(code, 2);
  assert.deepEqual(out.lines(), [created]);
  assert.match(out.errText(), /run owner/);
});

test("tail --json prints an end event with no newline once the run owner is gone", async () => {
  const { home, runId } = newRun();
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.activity, "start\n");
  await writeFile(paths.events, `${created}\n${endEvent(2)}`);

  const out = capture();
  const code = await tailCommand(
    ["tail", runId, "--json"],
    out.out,
    out.err,
    { LOOPFILE_HOME: home },
    { pollIntervalMs: 20, ownerPingTimeoutMs: 200 },
  );

  assert.equal(code, 0);
  assert.deepEqual(out.lines(), [created, endEvent(2)]);
});
