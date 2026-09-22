import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UNKNOWN_METRICS } from "../application/status-projection.ts";
import { LOOP_STATUS_FORMAT_VERSION, STATUS_FORMAT_VERSION } from "../domain/status.ts";
import { listCommand } from "./list-command.ts";
import { loopPaths, runPaths } from "./run-directory.ts";

const home = await mkdtemp(join(tmpdir(), "loopfile-list-"));
const env = { LOOPFILE_HOME: home };

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

/** Built from `String.fromCharCode` rather than written literally, so no control character reaches the source. */
const ESC = String.fromCharCode(27);

function statusBody(
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    visitedSteps: [],
    lastTransition: null,
    transitions: 0,
    maxTransitions: null,
    metrics: UNKNOWN_METRICS,
    ...overrides,
  };
}

function loopStatusBody(
  loopId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    formatVersion: LOOP_STATUS_FORMAT_VERSION,
    seq: 1,
    loopId,
    loopfileName: "review-loop",
    state: "completed",
    source: { kind: "times", count: 2 },
    fixedInputs: {},
    retry: 0,
    maxRuns: null,
    place: 2,
    runs: 2,
    retries: 0,
    lastInputSet: {},
    lastSourceIndex: 2,
    lastRetryCount: 0,
    runIds: [],
    currentRunId: null,
    pausedUntil: null,
    cancelRequested: null,
    endReason: "max_runs",
    cancelMode: null,
    detail: null,
    startedAt: "2026-09-17T16:03:00.000Z",
    endedAt: "2026-09-17T16:04:00.000Z",
    ...overrides,
  };
}

test("an unknown flag uses the operator failure block and exit 2", async () => {
  const r = runner();
  const code = await listCommand(["list", "--bogus"], r.out, r.err, env, false);
  assert.equal(code, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /^error: .*unknown argument: --bogus/);
  assert.match(r.errors, /\ncode: bad_argument\n/);
  assert.match(r.errors, /\nhelp: /);
});

test("with no runs, list prints a short message and exits 0", async () => {
  const r = runner();
  const code = await listCommand(
    ["list"],
    r.out,
    r.err,
    { LOOPFILE_HOME: join(home, "empty") },
    false,
  );
  assert.equal(code, 0);
  assert.equal(r.output, "no runs found\n");
});

test("with no runs, --json gives an empty array and exits 0", async () => {
  const r = runner();
  const code = await listCommand(
    ["list", "--json"],
    r.out,
    r.err,
    { LOOPFILE_HOME: join(home, "empty-json") },
    false,
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(r.output), { formatVersion: 1, loops: [], runs: [] });
});

test("list shows a run as a table row and exits 0", async () => {
  const runId = "20260917-160300-cccc";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  await writeFile(runPaths(home, runId).status, JSON.stringify(statusBody(runId)));

  const r = runner();
  const code = await listCommand(["list"], r.out, r.err, env, false);
  assert.equal(code, 0);
  assert.match(r.output, new RegExp(runId));
  assert.equal(r.output.includes(ESC), false);
  assert.equal(r.errors, "");
});

test("list shows a loop table before its runs and links both run rows", async () => {
  const listHome = join(home, "loop-with-runs");
  const loopId = "loop-20260917-160400-abcd";
  const runIds = ["20260917-160301-abcd", "20260917-160302-abcd"];
  await mkdir(loopPaths(listHome, loopId).root, { recursive: true });
  await writeFile(loopPaths(listHome, loopId).status, JSON.stringify(loopStatusBody(loopId)));
  for (const runId of runIds) {
    await mkdir(runPaths(listHome, runId).root, { recursive: true });
    await writeFile(
      runPaths(listHome, runId).status,
      JSON.stringify(statusBody(runId, { loopId })),
    );
  }

  const r = runner();
  const code = await listCommand(["list"], r.out, r.err, { LOOPFILE_HOME: listHome }, false);
  assert.equal(code, 0);
  assert.match(r.output, /^LOOP ID\s+STATE\s+SOURCE\s+RUNS\s+STARTED\s+ELAPSED\s+LOOPFILE/);
  assert.ok(r.output.indexOf("LOOP ID") < r.output.indexOf("RUN ID"));
  for (const runId of runIds) assert.match(r.output, new RegExp(`${runId}\\s+${loopId}`));
  assert.equal(r.output.split("\n")[2], "");
});

test("--json carries loops and the loop link on each run", async () => {
  const jsonHome = join(home, "loop-json");
  const loopId = "loop-20260917-160500-abcd";
  const runId = "20260917-160501-abcd";
  await mkdir(loopPaths(jsonHome, loopId).root, { recursive: true });
  await writeFile(
    loopPaths(jsonHome, loopId).status,
    JSON.stringify(loopStatusBody(loopId, { source: { kind: "list", count: 2 } })),
  );
  await mkdir(runPaths(jsonHome, runId).root, { recursive: true });
  await writeFile(runPaths(jsonHome, runId).status, JSON.stringify(statusBody(runId, { loopId })));

  const r = runner();
  const code = await listCommand(
    ["list", "--json"],
    r.out,
    r.err,
    { LOOPFILE_HOME: jsonHome },
    false,
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(r.output);
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.loops[0].loopId, loopId);
  assert.deepEqual(parsed.loops[0].source, { kind: "list", count: 2 });
  assert.equal(parsed.runs[0].loopId, loopId);
});

test("--json carries the format version and one entry per run, with no ANSI", async () => {
  const runId = "20260917-160301-dddd";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  await writeFile(runPaths(home, runId).status, JSON.stringify(statusBody(runId)));

  const r = runner();
  const code = await listCommand(["list", "--json"], r.out, r.err, env, true);
  assert.equal(code, 0);
  const parsed = JSON.parse(r.output);
  assert.equal(parsed.formatVersion, 1);
  assert.ok(parsed.runs.some((entry: { runId: string }) => entry.runId === runId));
  assert.equal(r.output.includes(ESC), false);
});

test("an unreadable event log uses the operator failure block and exit 2", async () => {
  const runId = "20260917-160308-ffff";
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.status,
    JSON.stringify(statusBody(runId, { state: "running", endReason: null })),
  );

  const r = runner();
  const code = await listCommand(["list"], r.out, r.err, env, false);
  assert.equal(code, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /\ncode: log_unreadable\n/);
  assert.match(r.errors, /\nhelp: /);
  await rm(paths.root, { recursive: true, force: true });
});

test("a corrupt event log uses the operator failure block and exit 2", async () => {
  const runId = "20260917-160309-gggg";
  const paths = runPaths(home, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.status,
    JSON.stringify(statusBody(runId, { state: "running", endReason: null })),
  );
  await writeFile(
    paths.events,
    `${JSON.stringify({ type: "run.created", seq: 1, at: "2026-09-17T16:03:00.000Z", runId })}\nbroken\n${JSON.stringify({ type: "owner.started", seq: 2, at: "2026-09-17T16:03:01.000Z", pid: 1, host: "host" })}\n`,
  );

  const r = runner();
  const code = await listCommand(["list"], r.out, r.err, env, false);
  assert.equal(code, 2);
  assert.equal(r.output, "");
  assert.match(r.errors, /\ncode: log_corrupt\n/);
  assert.match(r.errors, /\nhelp: /);
  await rm(paths.root, { recursive: true, force: true });
});

test("a failure reading the runs folder names the runs folder", async () => {
  const brokenHome = await mkdtemp(join(tmpdir(), "loopfile-list-broken-"));
  await writeFile(join(brokenHome, "runs"), "not a directory");

  try {
    const r = runner();
    const code = await listCommand(["list"], r.out, r.err, { LOOPFILE_HOME: brokenHome }, false);
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

test("list never writes to the run folder", async () => {
  const runId = "20260917-160302-eeee";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  await writeFile(runPaths(home, runId).status, JSON.stringify(statusBody(runId)));

  const r = runner();
  await listCommand(["list"], r.out, r.err, env, false);

  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(runPaths(home, runId).root)).sort();
  assert.deepEqual(files, ["status.json"]);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
