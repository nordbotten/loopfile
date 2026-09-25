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

test("list shows a loop row when there are no runs", async () => {
  const listHome = join(home, "loop-without-runs");
  const loopId = "loop-20260917-160350-abcd";
  await mkdir(loopPaths(listHome, loopId).root, { recursive: true });
  await writeFile(loopPaths(listHome, loopId).status, JSON.stringify(loopStatusBody(loopId)));

  const r = runner();
  const code = await listCommand(["list"], r.out, r.err, { LOOPFILE_HOME: listHome }, false);
  assert.equal(code, 0);
  assert.equal(r.output.includes("no runs found"), false);
  assert.match(r.output, new RegExp(`${loopId}\\s+completed\\s+times 2\\s+2`));
});

test("list shows the last attempted step, not the last first-visited step, after completion", async () => {
  const listHome = join(home, "completed-run-step");
  const runId = "20260917-160305-abcd";
  const paths = runPaths(listHome, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.status,
    JSON.stringify(
      statusBody(runId, {
        visitedSteps: [
          { stepId: "ship", attempts: 2 },
          { stepId: "fix", attempts: 1 },
          { stepId: "retest", attempts: 1 },
        ],
        lastTransition: { from: "ship", to: "$success", cause: "on", outcome: "merged" },
      }),
    ),
  );
  const json = runner();
  assert.equal(
    await listCommand(["list", "--json"], json.out, json.err, { LOOPFILE_HOME: listHome }, false),
    0,
  );
  assert.equal(JSON.parse(json.output).runs[0].currentStep, "ship");

  const human = runner();
  assert.equal(
    await listCommand(["list"], human.out, human.err, { LOOPFILE_HOME: listHome }, false),
    0,
  );
  assert.match(human.output, new RegExp(`${runId}\\s+-\\s+completed\\s+ship`));
});

test("list finds the last attempt on a cancelled run rather than using its incoming transition", async () => {
  const listHome = join(home, "cancelled-run-step");
  const runId = "20260917-160306-abcd";
  const paths = runPaths(listHome, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.status,
    JSON.stringify(
      statusBody(runId, {
        state: "cancelled",
        endReason: "cancelled",
        visitedSteps: [
          { stepId: "retest", attempts: 1 },
          { stepId: "ship", attempts: 1 },
        ],
        lastTransition: { from: "ship", to: "retest", cause: "on", outcome: "changes_requested" },
      }),
    ),
  );
  await writeFile(
    paths.events,
    `${[
      { type: "run.created", seq: 1, at: "2026-09-17T16:03:00.000Z", runId },
      { type: "attempt.started", seq: 2, at: "2026-09-17T16:04:00.000Z", stepId: "ship" },
      { type: "attempt.started", seq: 3, at: "2026-09-17T16:04:01.000Z", stepId: "retest" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );

  const r = runner();
  assert.equal(
    await listCommand(["list", "--json"], r.out, r.err, { LOOPFILE_HOME: listHome }, false),
    0,
  );
  assert.equal(JSON.parse(r.output).runs[0].currentStep, "retest");
});

test("list shows a run as a table row and exits 0", async () => {
  const runId = "20260917-160300-cccc";
  await mkdir(runPaths(home, runId).root, { recursive: true });
  await writeFile(runPaths(home, runId).status, JSON.stringify(statusBody(runId)));

  const r = runner();
  const code = await listCommand(["list"], r.out, r.err, env, false);
  assert.equal(code, 0);
  assert.match(r.output, new RegExp(runId));
  assert.doesNotMatch(r.output.split("\n")[0] ?? "", /remote/i);
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
  const entry = parsed.runs.find((row: { runId: string }) => row.runId === runId);
  assert.equal(entry.remote, null);
  assert.equal(r.output.includes(ESC), false);
});

test("list does not expose call fields from the event log", async () => {
  const listHome = join(home, "call-fields-unchanged");
  const runId = "20260917-160310-abcd";
  const paths = runPaths(listHome, runId);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.status, JSON.stringify(statusBody(runId)));
  await writeFile(
    paths.events,
    `${[
      {
        type: "run.created",
        seq: 1,
        at: "2026-09-17T16:03:00.000Z",
        runId,
        eventFormatVersion: 1,
        modelDigest: "sha256:model",
        targetFolder: "/repo",
        inputs: [],
      },
      {
        type: "attempt.started",
        seq: 2,
        at: "2026-09-17T16:03:01.000Z",
        attemptId: "001-review",
        stepId: "review",
        processGroupId: 1,
        fields: { model: "opus", effort: "high" },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );

  const json = runner();
  assert.equal(
    await listCommand(["list", "--json"], json.out, json.err, { LOOPFILE_HOME: listHome }, false),
    0,
  );
  const run = JSON.parse(json.output).runs[0];
  assert.deepEqual(Object.keys(run).sort(), [
    "currentStep",
    "elapsedMs",
    "loopId",
    "loopfileName",
    "remote",
    "runId",
    "startedAt",
    "state",
  ]);
  assert.equal(run.currentStep, "review");
  assert.doesNotMatch(json.output, /opus|model|effort|fields/);

  const text = runner();
  assert.equal(
    await listCommand(["list"], text.out, text.err, { LOOPFILE_HOME: listHome }, false),
    0,
  );
  assert.doesNotMatch(text.output, /opus|model|effort|fields/);
});

test("--json gives each run its remote record or null", async () => {
  const listHome = join(home, "remote-json");
  const remoteId = "20260917-161010-rmaa";
  const localId = "20260917-161011-rmab";
  const remote = {
    host: "github.com",
    repo: "acme/loops",
    path: "review",
    ref: "main",
    sha: "4c9d077abcde1234567890abcdef1234567890ab",
  };
  for (const [runId, value] of [
    [remoteId, remote],
    [localId, undefined],
  ] as const) {
    await mkdir(runPaths(listHome, runId).root, { recursive: true });
    await writeFile(
      runPaths(listHome, runId).status,
      JSON.stringify(statusBody(runId, value === undefined ? {} : { remote: value })),
    );
  }

  const r = runner();
  assert.equal(
    await listCommand(["list", "--json"], r.out, r.err, { LOOPFILE_HOME: listHome }, false),
    0,
  );
  const runs = JSON.parse(r.output).runs;
  assert.deepEqual(runs.find((run: { runId: string }) => run.runId === remoteId).remote, remote);
  assert.equal(runs.find((run: { runId: string }) => run.runId === localId).remote, null);
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
