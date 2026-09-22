import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AttemptCall } from "../application/owner-protocol.ts";
import { parseEventLog } from "../application/replay.ts";
import { RunDirectoryError, runPaths } from "./run-directory.ts";
import {
  pingOwner,
  type RunOwner,
  RunOwnerBusyError,
  requestCancel,
  startRunOwner,
} from "./run-owner.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-owner-"));
let counter = 0;

/** A home with the run folder already made, the way the CLI leaves it (#81). */
async function newRun(): Promise<{ home: string; runId: string }> {
  counter += 1;
  const home = join(scratch, `home-${counter}`);
  const runId = `20260917-160344-r${counter}`;
  await mkdir(runPaths(home, runId).root, { recursive: true });
  return { home, runId };
}

/** Sends one line and collects what comes back, then hangs up. */
function ask(path: string, request?: unknown, lines = 1): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const replies: Record<string, unknown>[] = [];
    const socket = connect(path);
    let pending = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${path}`));
    }, 5_000);
    socket.on("connect", () => {
      if (request !== undefined) socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) if (part !== "") replies.push(JSON.parse(part));
      if (replies.length >= lines) {
        clearTimeout(timer);
        socket.destroy();
        resolve(replies);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function started(): Promise<RunOwner> {
  const { home, runId } = await newRun();
  return await startRunOwner({ home, runId, probeTimeoutMs: 250 });
}

test("a run owner greets each client with ready and answers a ping with the run ID", async (t) => {
  const owner = await started();
  t.after(() => owner.close());

  const [ready, pong] = await ask(owner.paths.socket, { type: "ping" }, 2);
  assert.deepEqual(ready, { type: "ready", runId: owner.runId });
  assert.deepEqual(pong, { type: "pong", runId: owner.runId });
});

test("a run owner records itself in the event log with its pid and host", async (t) => {
  const owner = await started();
  t.after(() => owner.close());

  const events = parseEventLog(await readFile(owner.paths.events, "utf8"));
  assert.deepEqual(events, [
    { seq: 1, at: events[0]?.at, type: "owner.started", pid: process.pid, host: hostname() },
  ]);
});

test("a second run owner refuses to start while the first one answers", async (t) => {
  const owner = await started();
  t.after(() => owner.close());

  const second = startRunOwner({
    home: join(owner.paths.root, "..", ".."),
    runId: owner.runId,
    probeTimeoutMs: 250,
  });
  await assert.rejects(second, RunOwnerBusyError);
  await assert.rejects(second, /already running/);

  const [ready] = await ask(owner.paths.socket);
  assert.deepEqual(ready, { type: "ready", runId: owner.runId }, "the first owner still answers");
});

test("a socket a crash left behind is replaced, and the run owner starts", async (t) => {
  const { home, runId } = await newRun();
  const paths = runPaths(home, runId);
  await writeFile(paths.socket, "left over by a crashed run owner");

  const owner = await startRunOwner({ home, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());

  const [ready] = await ask(paths.socket);
  assert.deepEqual(ready, { type: "ready", runId });
  assert.ok((await stat(paths.socket)).isSocket(), "the leftover file is now the socket");
});

test("a socket path that is too long fails with an error that names the path", async () => {
  const runId = "20260917-160344-long";
  const home = join(scratch, "d".repeat(120));
  await mkdir(runPaths(home, runId).root, { recursive: true });

  await assert.rejects(startRunOwner({ home, runId }), (error: Error) => {
    assert.ok(error instanceof RunDirectoryError);
    assert.match(error.message, /byte limit/);
    assert.match(error.message, /owner\.sock/);
    return true;
  });
});

test("a socket something else answers on is refused, not removed", async (t) => {
  const { home, runId } = await newRun();
  const paths = runPaths(home, runId);
  const answered = new Set<Socket>();
  const stranger = createServer((socket) => {
    answered.add(socket);
    socket.write(`${JSON.stringify({ type: "pong", runId: "someone-else" })}\n`);
  });
  await new Promise<void>((resolve) => stranger.listen(paths.socket, resolve));
  t.after(() => {
    for (const socket of answered) socket.destroy();
    return new Promise<void>((resolve) => stranger.close(() => resolve()));
  });

  await assert.rejects(
    startRunOwner({ home, runId, probeTimeoutMs: 1_000 }),
    /something else is already listening/,
  );
  assert.ok((await stat(paths.socket)).isSocket(), "the stranger's socket is left alone");
});

test("a run owner that cannot open its event log gives the socket back", async (t) => {
  const { home, runId } = await newRun();
  const paths = runPaths(home, runId);
  // A folder where `events.jsonl` goes: opening it for appending fails.
  await mkdir(paths.events);
  await assert.rejects(startRunOwner({ home, runId, probeTimeoutMs: 250 }));
  await assert.rejects(stat(paths.socket), "a half-started owner leaves no lock behind");

  await rm(paths.events, { recursive: true });
  const owner = await startRunOwner({ home, runId, probeTimeoutMs: 250 });
  t.after(() => owner.close());
  const [ready] = await ask(paths.socket);
  assert.deepEqual(ready, { type: "ready", runId }, "the next run owner takes the run");
});

test("ready comes after the event log is open, not before", async (t) => {
  const owner = await started();
  t.after(() => owner.close());

  const [ready] = await ask(owner.paths.socket);
  assert.deepEqual(ready, { type: "ready", runId: owner.runId });
  const events = parseEventLog(await readFile(owner.paths.events, "utf8"));
  assert.equal(events[0]?.type, "owner.started", "the run is on the record before anyone is told");
});

const IDENTITY = { attemptId: "007-fix", secret: "s3cret" };

async function withAttempt(t: { after(fn: () => unknown): void }) {
  const owner = await started();
  t.after(() => owner.close());
  const calls: AttemptCall[] = [];
  const attempt = await owner.serveAttempt({
    socketPath: join(owner.paths.root, "sock"),
    current: () => IDENTITY,
    handle: (call) => {
      calls.push(call);
      return { ok: true, summary: `ran ${call.argv.join(" ")}` };
    },
  });
  return { owner, attempt, calls };
}

test("the attempt socket sends a matching call to its handler and replies", async (t) => {
  const { attempt, calls } = await withAttempt(t);

  const [reply] = await ask(attempt.endpoint, { ...IDENTITY, argv: ["data", "get", "spec.md"] });
  assert.deepEqual(reply, { ok: true, summary: "ran data get spec.md" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.argv, ["data", "get", "spec.md"]);
});

test("the attempt socket refuses a wrong attempt ID or secret, and calls no handler", async (t) => {
  const { attempt, calls } = await withAttempt(t);

  for (const call of [
    { ...IDENTITY, attemptId: "006-review", argv: ["result", "approved"] },
    { ...IDENTITY, secret: "guessed", argv: ["result", "approved"] },
  ]) {
    const [reply] = await ask(attempt.endpoint, call);
    assert.deepEqual(reply, {
      ok: false,
      code: "stale_attempt",
      message: "not the attempt running now (007-fix)",
    });
  }
  assert.equal(calls.length, 0, "a refused call never reaches the handler");
});

test("on a Ralph step only the iteration running now is answered", async (t) => {
  const owner = await started();
  t.after(() => owner.close());
  const identity = { ...IDENTITY, iteration: 2 };
  const calls: AttemptCall[] = [];
  const attempt = await owner.serveAttempt({
    socketPath: join(owner.paths.root, "sock"),
    current: () => identity,
    handle: (call) => {
      calls.push(call);
      return { ok: true };
    },
  });

  const [stale] = await ask(attempt.endpoint, {
    ...identity,
    iteration: 1,
    argv: ["result", "ok"],
  });
  assert.equal((stale as { code?: string }).code, "stale_attempt");
  assert.equal(calls.length, 0, "the iteration before this one is left over");

  const [current] = await ask(attempt.endpoint, { ...identity, argv: ["result", "ok"] });
  assert.deepEqual(current, { ok: true });
  assert.equal(calls[0]?.iteration, 2);
});

test("a call is refused when no identity is current, and the socket reads it for each call", async (t) => {
  const owner = await started();
  t.after(() => owner.close());
  let now: typeof IDENTITY | undefined;
  const calls: AttemptCall[] = [];
  const attempt = await owner.serveAttempt({
    socketPath: join(owner.paths.root, "sock"),
    current: () => now,
    handle: (call) => {
      calls.push(call);
      return { ok: true };
    },
  });

  const [refused] = await ask(attempt.endpoint, { ...IDENTITY, argv: ["result", "ok"] });
  assert.deepEqual(refused, {
    ok: false,
    code: "stale_attempt",
    message: "no iteration is running",
  });
  assert.equal(calls.length, 0);

  now = IDENTITY;
  const [accepted] = await ask(attempt.endpoint, { ...IDENTITY, argv: ["result", "ok"] });
  assert.deepEqual(accepted, { ok: true });
  assert.equal(calls.length, 1);
});

test("closing the run owner closes the attempt sockets with it", async (t) => {
  const { owner, attempt } = await withAttempt(t);
  await owner.close();
  await owner.stopped;

  await assert.rejects(ask(attempt.endpoint, { ...IDENTITY, argv: ["x"] }));
  await assert.rejects(ask(owner.paths.socket));
});

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("a created event is appended before owner.started", async () => {
  const { home, runId } = await newRun();
  const owner = await startRunOwner({
    home,
    runId,
    created: async () => ({
      type: "run.created",
      runId,
      eventFormatVersion: 1,
      modelDigest: "d",
      repositoryPath: "/repo",
      baseCommit: "abc",
      branch: `loopfile/${runId}`,
      inputs: [],
    }),
  });
  await owner.close();
  const events = parseEventLog(await readFile(runPaths(home, runId).events, "utf8"));
  assert.deepEqual(
    events.map((event) => [event.seq, event.type]),
    [
      [1, "run.created"],
      [2, "owner.started"],
    ],
  );
});

test("a created event that fails gives the socket back and writes no event", async () => {
  const { home, runId } = await newRun();
  await assert.rejects(
    startRunOwner({
      home,
      runId,
      created: async () => {
        throw new Error("no workspace");
      },
    }),
    /no workspace/,
  );
  const paths = runPaths(home, runId);
  await assert.rejects(stat(paths.socket));
  assert.equal(await readFile(paths.events, "utf8"), "");
  await (await startRunOwner({ home, runId })).close();
});

test("cancel on the control socket is confirmed and aborts cancelled", async (t) => {
  const owner = await started();
  t.after(() => owner.close());
  assert.equal(owner.cancelled.aborted, false);
  assert.equal(await requestCancel(owner.paths.socket, owner.runId), true);
  assert.equal(owner.cancelled.aborted, true);
  assert.equal(await pingOwner(owner.paths.socket), owner.runId, "the socket stays until close");
});

test("a signal from outside aborts cancelled too, even one that fired first", async (t) => {
  const outside = new AbortController();
  const { home, runId } = await newRun();
  const owner = await startRunOwner({ home, runId, cancelSignal: outside.signal });
  t.after(() => owner.close());
  assert.equal(owner.cancelled.aborted, false);
  outside.abort();
  assert.equal(owner.cancelled.aborted, true);

  const early = await newRun();
  const second = await startRunOwner({ ...early, cancelSignal: AbortSignal.abort() });
  t.after(() => second.close());
  assert.equal(second.cancelled.aborted, true);
});

test("a cancel is not confirmed by a socket nobody serves, or by another run's owner", async (t) => {
  const { home, runId } = await newRun();
  assert.equal(await requestCancel(runPaths(home, runId).socket, runId, 250), false);
  const owner = await started();
  t.after(() => owner.close());
  assert.equal(await requestCancel(owner.paths.socket, runId, 250), false);
});
