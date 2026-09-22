import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEventLog } from "../application/replay.ts";
import { ownerCommand } from "./owner-command.ts";
import { runPaths } from "./run-directory.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-owner-cli-"));
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

function errors(): { text: () => string; write: (text: string) => void } {
  let collected = "";
  return {
    text: () => collected,
    write: (text: string) => {
      collected += text;
    },
  };
}

test("__owner without a run ID says so and exits 2", async () => {
  const err = errors();
  assert.equal(await ownerCommand([], err.write, {}), 2);
  assert.match(err.text(), /needs a run ID/);
  assert.equal(await ownerCommand([""], err.write, {}), 2);
});

test("a launch request that is not one is refused with exit 2", async () => {
  const err = errors();
  const env = { LOOPFILE_HOME: join(scratch, "home-bad"), LOOPFILE_LAUNCH: "nope" };
  assert.equal(await ownerCommand(["20260917-160344-bad"], err.write, env), 2);
  assert.match(err.text(), /LOOPFILE_LAUNCH is not a launch request/);
});

test("a run owner that cannot start says why and exits 1", async () => {
  const runId = "20260917-160344-busy";
  const home = join(scratch, "d".repeat(120));
  await mkdir(runPaths(home, runId).root, { recursive: true });

  const err = errors();
  assert.equal(await ownerCommand([runId], err.write, { LOOPFILE_HOME: home }), 1);
  assert.match(err.text(), /byte limit/);
});

test("`loopfile __owner <runid>` binds the socket, says ready and answers a ping", async (t) => {
  const home = join(scratch, "home");
  const runId = "20260917-160344-cli1";
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });

  const owner = spawn(process.execPath, [cli, "__owner", runId], {
    env: { ...process.env, LOOPFILE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => owner.kill("SIGKILL"));

  // A client that pings while the run owner is still starting is answered
  // straight away and greeted when the run owner is ready, so the two can
  // arrive in either order. Both carry the run ID, which is what a reader of
  // the socket is after.
  const replies = await waitForAnswer(paths.socket, owner);
  assert.deepEqual(new Set(replies.map((reply) => reply.type)), new Set(["ready", "pong"]));
  for (const reply of replies) assert.equal(reply.runId, runId);

  const events = parseEventLog(await readFile(paths.events, "utf8"));
  assert.equal(events[0]?.type, "owner.started");
  assert.equal(events.length, 1);
});

/**
 * Connects until the run owner has bound its socket, then pings it.
 *
 * The process is spawned, so the socket appears some time after the child
 * does; a first `ECONNREFUSED` or `ENOENT` means "not yet", not "never".
 */
async function waitForAnswer(
  path: string,
  owner: { exitCode: number | null },
  until = Date.now() + 10_000,
): Promise<Record<string, string>[]> {
  for (;;) {
    const replies = await pingOnce(path).catch(() => undefined);
    if (replies !== undefined) return replies;
    assert.equal(owner.exitCode, null, "the run owner exited before it was ready");
    assert.ok(Date.now() < until, `no answer from ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function pingOnce(path: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let pending = "";
    const replies: Record<string, string>[] = [];
    socket.on("connect", () => socket.write('{"type":"ping"}\n'));
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) if (part !== "") replies.push(JSON.parse(part));
      if (replies.length >= 2) {
        socket.destroy();
        resolve(replies);
      }
    });
    socket.on("error", reject);
  });
}

test.after(async () => {
  await rm(scratch, { recursive: true, force: true });
});
