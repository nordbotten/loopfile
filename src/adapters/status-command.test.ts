import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { UNKNOWN_METRICS } from "../application/status-projection.ts";
import { STATUS_FORMAT_VERSION } from "../domain/status.ts";
import type { MonitorIo } from "./monitor.ts";
import { runPaths } from "./run-directory.ts";
import { statusCommand } from "./status-command.ts";

const home = await mkdtemp(join(tmpdir(), "loopfile-status-"));
const env = { LOOPFILE_HOME: home };
after(() => rm(home, { recursive: true, force: true }));

const ESC = String.fromCharCode(27);

function runner() {
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

function statusBody(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: STATUS_FORMAT_VERSION,
    seq: 1,
    updatedAt: "2026-09-17T16:04:00.000Z",
    runId,
    loopfileName: "review-loop",
    state: "completed",
    endReason: "success",
    startedAt: "2026-09-17T16:03:00.000Z",
    endedAt: "2026-09-17T16:04:00.000Z",
    current: null,
    lastActivityAt: "2026-09-17T16:04:00.000Z",
    lastProgress: null,
    visitedSteps: [{ stepId: "plan", attempts: 1 }],
    lastTransition: null,
    transitions: 1,
    maxTransitions: null,
    metrics: UNKNOWN_METRICS,
    ...overrides,
  };
}

async function makeRun(
  runId: string,
  overrides: Record<string, unknown> = {},
  host?: string,
  dir: string = home,
) {
  const paths = runPaths(dir, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, JSON.stringify(statusBody(runId, overrides)));
  const lines = [
    { type: "run.created", seq: 1, at: "2026-09-17T16:03:00.000Z", runId },
    ...(host === undefined
      ? []
      : [{ type: "owner.started", seq: 2, at: "2026-09-17T16:03:00.000Z", pid: 1, host }]),
    {
      type: "transition",
      seq: 3,
      at: "2026-09-17T16:03:30.000Z",
      from: "plan",
      attemptId: "a1",
      result: "success",
      reason: "reported",
      outcome: "approved",
      to: "build",
      cause: "on",
    },
  ];
  await writeFile(paths.events, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return paths;
}

const RUNNING = { state: "running", endReason: null, endedAt: null };

test("an ended run prints its human view and exits 0", async () => {
  await makeRun("20260917-160300-aaaa");
  const r = runner();
  const code = await statusCommand(["status", "20260917-160300-aaaa"], r.out, r.err, env);
  assert.equal(code, 0);
  assert.match(r.output, /^state +completed$/m);
  assert.match(r.output, /^outcome +success/m);
  assert.match(r.output, /plan -> build \(on, outcome approved\)/);
  assert.match(r.output, /tool calls unknown/);
  assert.equal(r.output.includes(ESC), false);
  assert.equal(r.errors, "");
});

test("a run with no end event and a dead socket is crashed", async () => {
  await makeRun("20260917-160301-bbbb", RUNNING);
  const r = runner();
  const code = await statusCommand(["status", "20260917-160301-bbbb"], r.out, r.err, env, {
    pingTimeoutMs: 100,
  });
  assert.equal(code, 0);
  assert.match(r.output, /^state +crashed$/m);
});

test("a run whose last owner.started host is another host is unknown", async () => {
  await makeRun("20260917-160302-cccc", RUNNING, "some-other-host");
  const r = runner();
  await statusCommand(["status", "20260917-160302-cccc"], r.out, r.err, env, {
    pingTimeoutMs: 100,
  });
  assert.match(r.output, /^state +unknown$/m);
});

test("--json has the format version, derived state, null metrics and no ANSI", async () => {
  await makeRun("20260917-160303-dddd", RUNNING);
  const r = runner();
  const code = await statusCommand(
    ["status", "20260917-160303-dddd", "--json"],
    r.out,
    r.err,
    env,
    { pingTimeoutMs: 100 },
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(r.output);
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.state, "crashed");
  assert.equal(parsed.metrics.costUsd, null);
  assert.equal(parsed.recentTransitions[0].to, "build");
  assert.equal(r.output.includes(ESC), false);
  assert.equal(r.output.endsWith("\n"), true);
});

test("--json passes an unknown endReason through and exits 0", async () => {
  const runId = "20260917-160310-jjjj";
  await makeRun(runId, { endReason: "internal_error" });
  const r = runner();
  const code = await statusCommand(["status", runId, "--json"], r.out, r.err, env);
  assert.equal(code, 0);
  assert.equal(JSON.parse(r.output).endReason, "internal_error");
  assert.equal(r.errors, "");
});

test("--json without a run ID fails with the operator block", async () => {
  const r = runner();
  const code = await statusCommand(["status", "--json"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /^error: .*needs a run ID/);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
  assert.equal(r.output, "");
});

test("an unknown run ID gives a clear operator failure", async () => {
  const r = runner();
  const code = await statusCommand(["status", "20260917-160399-zzzz"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /^error: .*20260917-160399-zzzz/);
  assert.match(r.errors, /\ncode: no_such_run\n/);
  assert.match(r.errors, /\nhelp: /);
  assert.equal(r.output, "");
});

test("a run with no readable status.json gives a clear error", async () => {
  const paths = runPaths(home, "20260917-160304-eeee");
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.events, "");
  const r = runner();
  const code = await statusCommand(["status", "20260917-160304-eeee"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.match(r.errors, /no readable status.json/);
  assert.doesNotMatch(r.errors, /events.jsonl/);
  assert.match(r.errors, /\ncode: log_unreadable\n/);
  assert.match(r.errors, /\nhelp: /);
  assert.equal(r.output, "");
});

test("an unreadable events.jsonl gives a log_unreadable failure", async () => {
  const paths = await makeRun("20260917-160305-ffff");
  await rm(paths.events);
  const r = runner();
  const code = await statusCommand(["status", "20260917-160305-ffff"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /\ncode: log_unreadable\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("a corrupt events.jsonl gives a log_corrupt failure", async () => {
  const paths = await makeRun("20260917-160307-hhhh");
  await writeFile(
    paths.events,
    `${JSON.stringify({ type: "run.created", seq: 1, at: "2026-09-17T16:03:00.000Z", runId: "bad" })}\nbroken\n${JSON.stringify({ type: "owner.started", seq: 3, at: "2026-09-17T16:04:00.000Z", pid: 1, host: "host" })}\n`,
  );
  const r = runner();
  const code = await statusCommand(["status", "20260917-160307-hhhh"], r.out, r.err, env);
  assert.equal(code, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /\ncode: log_corrupt\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("status never changes a run file", async () => {
  const id = "20260917-160306-gggg";
  const paths = await makeRun(id, RUNNING);
  const snapshot = async () =>
    Promise.all(
      (await readdir(paths.root)).sort().map(async (name) => {
        const file = join(paths.root, name);
        return [name, (await stat(file)).mtimeMs, await readFile(file, "utf8")];
      }),
    );
  const before = await snapshot();
  const r = runner();
  await statusCommand(["status", id], r.out, r.err, env, { pingTimeoutMs: 100 });
  await statusCommand(["status", id, "--json"], r.out, r.err, env, { pingTimeoutMs: 100 });
  assert.deepEqual(await snapshot(), before);
});

function terminal(tty: boolean): { io: MonitorIo; input: PassThrough; text(): string } {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} });
  let written = "";
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return { io: { input, output }, input, text: () => stripVTControlCharacters(written) };
}

test("bare status with no terminal fails at once and names list and status <runid>", async () => {
  for (const [inTty, outTty] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const) {
    const t = terminal(true);
    (t.io.input as { isTTY?: boolean }).isTTY = inTty;
    (t.io.output as { isTTY?: boolean }).isTTY = outTty;
    const r = runner();
    const code = await statusCommand(["status"], r.out, r.err, env, { io: t.io });
    assert.equal(code, 2);
    assert.match(r.errors, /^error: /);
    assert.match(r.errors, /\ncode: no_terminal\n/);
    assert.match(r.errors, /\nhelp: /);
    assert.match(r.errors, /loopfile list/);
    assert.match(r.errors, /loopfile status <runid>/);
  }
});

test("bare status in a terminal with no runs says so and exits 0", async () => {
  const t = terminal(true);
  const r = runner();
  const code = await statusCommand(
    ["status"],
    r.out,
    r.err,
    { LOOPFILE_HOME: join(home, "none") },
    {
      io: t.io,
    },
  );
  assert.equal(code, 0);
  assert.match(t.text(), /no runs found/);
});

test("bare status names the runs folder when discovery cannot read it", async () => {
  const brokenHome = await mkdtemp(join(tmpdir(), "loopfile-status-broken-"));
  await writeFile(join(brokenHome, "runs"), "not a directory");
  const t = terminal(true);
  const r = runner();

  try {
    const code = await statusCommand(
      ["status"],
      r.out,
      r.err,
      { LOOPFILE_HOME: brokenHome },
      {
        io: t.io,
      },
    );
    assert.equal(code, 2);
    assert.equal(r.output, "");
    assert.match(r.errors, /could not read runs/);
    assert.doesNotMatch(r.errors, /events\.jsonl/);
    assert.match(r.errors, /\ncode: log_unreadable\n/);
    assert.match(r.errors, /\nhelp: /);
  } finally {
    await rm(brokenHome, { recursive: true, force: true });
  }
});

/** A home with one ended run, so a picker test does not depend on the other tests' runs. */
async function pickerHome(
  overrides: Record<string, unknown> = {},
): Promise<{ LOOPFILE_HOME: string }> {
  const dir = await mkdtemp(join(tmpdir(), "loopfile-status-pick-"));
  after(() => rm(dir, { recursive: true, force: true }));
  await makeRun("20260917-160300-pppp", overrides, undefined, dir);
  return { LOOPFILE_HOME: dir };
}

test("bare status in a terminal attaches the monitor to the picked run", async () => {
  const t = terminal(true);
  const r = runner();
  const result = statusCommand(["status"], r.out, r.err, await pickerHome(), {
    io: t.io,
    pingTimeoutMs: 100,
    monitor: { ownerPingTimeoutMs: 100, pollIntervalMs: 20 },
  });
  // Ask for a bad number first, then a valid one: the picker asks again.
  await waitFor(() => t.text().includes("Pick a run"));
  t.input.write("99\n");
  await waitFor(() => t.text().split("Pick a run").length > 2);
  t.input.write("1\n");
  const code = await result;
  const text = t.text();
  assert.match(text, /^ {4}RUN ID/m);
  assert.match(text, /1\) /);
  assert.match(text, /review-loop/);
  assert.equal(code, 0);
  assert.match(text, /^state +completed \(success\)$/m);
});

test("bare status reports a monitor read failure after the pick", async () => {
  const t = terminal(true);
  const r = runner();
  const runId = "20260917-160309-iiii";
  const dir = await mkdtemp(join(tmpdir(), "loopfile-status-monitor-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const paths = await makeRun(runId, {}, undefined, dir);
  const result = statusCommand(["status"], r.out, r.err, { LOOPFILE_HOME: dir }, { io: t.io });
  await waitFor(() => t.text().includes("Pick a run"));
  await writeFile(paths.status, "not json");
  t.input.write("1\n");
  assert.equal(await result, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /^error: /);
  assert.match(r.errors, /\ncode: log_unreadable\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("a crashed run that status read successfully exits 0 from the picker", async () => {
  const t = terminal(true);
  const r = runner();
  const result = statusCommand(["status"], r.out, r.err, await pickerHome(RUNNING), {
    io: t.io,
    pingTimeoutMs: 100,
    monitor: { ownerPingTimeoutMs: 100, pollIntervalMs: 20 },
  });
  await waitFor(() => t.text().includes("Pick a run"));
  t.input.write("1\n");
  assert.equal(await result, 0);
  assert.equal(r.output, "");
  assert.equal(r.errors, "");
});

test("a failed run that status read successfully exits 0 from the picker", async () => {
  const t = terminal(true);
  const r = runner();
  const result = statusCommand(
    ["status"],
    r.out,
    r.err,
    await pickerHome({ state: "failed", endReason: "failure" }),
    { io: t.io },
  );
  await waitFor(() => t.text().includes("Pick a run"));
  t.input.write("1\n");
  assert.equal(await result, 0);
  assert.equal(r.output, "");
  assert.equal(r.errors, "");
});

test("q at the picker quits without attaching", async () => {
  const t = terminal(true);
  const r = runner();
  const result = statusCommand(["status"], r.out, r.err, await pickerHome(), {
    io: t.io,
    pingTimeoutMs: 100,
  });
  await waitFor(() => t.text().includes("Pick a run"));
  t.input.write("q\n");
  assert.equal(await result, 0);
  assert.doesNotMatch(t.text(), /review-loop ·/);
});

test("input ending at the picker quits", async () => {
  const t = terminal(true);
  const r = runner();
  const result = statusCommand(["status"], r.out, r.err, await pickerHome(), {
    io: t.io,
    pingTimeoutMs: 100,
  });
  await waitFor(() => t.text().includes("Pick a run"));
  t.input.end();
  assert.equal(await result, 0);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(condition(), true, "timed out waiting");
}
