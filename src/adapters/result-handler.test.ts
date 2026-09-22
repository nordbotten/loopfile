import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEventLog } from "../application/replay.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId } from "../domain/model.ts";
import { reportResult } from "./attempt-client.ts";
import { createAttemptDirectory } from "./attempt-directory.ts";
import { resultHandler } from "./result-handler.ts";
import { type RunPaths, runPaths } from "./run-directory.ts";
import { type RunOwner, startRunOwner } from "./run-owner.ts";

const scratch = await mkdtemp(join(tmpdir(), "loopfile-result-"));
let counter = 0;

/** Mirrors `data-get-handler.test.ts`'s rig: the run owner plus events appended so far. */
interface Rig {
  readonly owner: RunOwner;
  readonly paths: RunPaths;
  readonly history: RunEvent[];
}

async function newRig(): Promise<Rig> {
  counter += 1;
  const home = join(scratch, `home-${counter}`);
  const runId = `20260917-160344-r${counter}`;
  await mkdir(runPaths(home, runId).root, { recursive: true });
  const owner = await startRunOwner({ home, runId, probeTimeoutMs: 250 });
  return { owner, paths: owner.paths, history: [] };
}

async function startAttempt(rig: Rig, attemptId: AttemptId, stepId: string): Promise<void> {
  await createAttemptDirectory(rig.paths.attempts, attemptId);
  rig.history.push(
    await rig.owner.events.append({
      type: "attempt.started",
      attemptId,
      stepId,
      processGroupId: 1,
    }),
  );
}

/** Records an earlier accepted `result` call directly, the way a real run owner's own event append would. */
async function reportOutcome(
  rig: Rig,
  attemptId: AttemptId,
  outcome: string,
  iteration?: number,
): Promise<void> {
  rig.history.push(
    await rig.owner.events.append({
      type: "outcome.reported",
      attemptId,
      outcome,
      ...(iteration === undefined ? {} : { iteration }),
    }),
  );
}

/** Serves `attemptId`'s socket with a `result` handler wired to `rig`. */
async function serveResult(
  rig: Rig,
  attemptId: AttemptId,
  secret: string,
  allowedOutcomes: readonly string[],
  iteration?: number,
) {
  const socketPath = join(rig.paths.attempts, attemptId, "sock");
  const endpoint = await rig.owner.serveAttempt({
    socketPath,
    current: () => ({ attemptId, secret, iteration }),
    handle: resultHandler({
      events: rig.owner.events,
      allowedOutcomes,
      history: () => rig.history,
    }),
  });
  return { socketPath, endpoint };
}

test("an accepted outcome is a report and an event", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveResult(rig, "001-review", "s3cret", [
    "approved",
    "changes_requested",
  ]);
  t.after(() => endpoint.close());

  const report = await reportResult(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "approved",
  );
  assert.deepEqual(report, { ok: true, summary: "reported approved" });

  const events = parseEventLog(await readFile(rig.paths.events, "utf8"));
  const got = events.find((event) => event.type === "outcome.reported");
  assert.ok(got);
  assert.equal(got.type, "outcome.reported");
  assert.equal(got.attemptId, "001-review");
  assert.equal(got.outcome, "approved");
  assert.ok(!("message" in got), "no message was given");
});

test("a message is carried on the event", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveResult(rig, "001-review", "s3cret", ["approved"]);
  t.after(() => endpoint.close());

  await reportResult(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "approved",
    "looks good",
  );

  const events = parseEventLog(await readFile(rig.paths.events, "utf8"));
  const got = events.find((event) => event.type === "outcome.reported");
  assert.ok(got && got.type === "outcome.reported");
  assert.equal(got.message, "looks good");
});

test("an outcome outside the step's `on` keys is refused with the allowed list", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveResult(rig, "001-review", "s3cret", ["approved"]);
  t.after(() => endpoint.close());

  const report = await reportResult(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "nope",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "bad_outcome");
  assert.match(report.help.join("\n"), /Allowed outcomes: approved/);

  const events = parseEventLog(await readFile(rig.paths.events, "utf8"));
  assert.equal(
    events.filter((event) => event.type === "outcome.reported").length,
    0,
    "a refused call never becomes an event",
  );
});

test("a step with no `on` map refuses every outcome", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveResult(rig, "001-review", "s3cret", []);
  t.after(() => endpoint.close());

  const report = await reportResult(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "approved",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "bad_outcome");
});

test("a second call in the same attempt is refused, naming the first outcome", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  await reportOutcome(rig, "001-review", "approved");

  const { socketPath, endpoint } = await serveResult(rig, "001-review", "s3cret", [
    "approved",
    "changes_requested",
  ]);
  t.after(() => endpoint.close());

  const report = await reportResult(
    { endpoint: socketPath, attemptId: "001-review", secret: "s3cret" },
    "changes_requested",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "bad_outcome");
  assert.match(report.summary, /already reported: approved/);
});

test("a Ralph step resets the one-outcome rule each iteration", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-implement", "implement");
  await reportOutcome(rig, "001-implement", "changes_requested", 1);

  const { socketPath, endpoint } = await serveResult(
    rig,
    "001-implement",
    "iteration-2-secret",
    ["approved", "changes_requested"],
    2,
  );
  t.after(() => endpoint.close());

  const report = await reportResult(
    {
      endpoint: socketPath,
      attemptId: "001-implement",
      secret: "iteration-2-secret",
      iteration: 2,
    },
    "approved",
  );
  assert.ok(report.ok, "iteration 2 must not be blocked by iteration 1's report");
});

test("a call for another command is not this handler's to answer", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());
  const handle = resultHandler({
    events: rig.owner.events,
    allowedOutcomes: [],
    history: () => [],
  });

  const reply = await handle({
    attemptId: "001-review",
    secret: "s3cret",
    argv: ["data", "get", "x"],
  });
  assert.deepEqual(reply, { ok: false, code: "unbuilt", message: "`data get x` is not built yet" });
});

test("a call with no outcome is a missing_arg refusal", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());
  const handle = resultHandler({
    events: rig.owner.events,
    allowedOutcomes: ["approved"],
    history: () => [],
  });

  const reply = await handle({ attemptId: "001-review", secret: "s3cret", argv: ["result"] });
  assert.deepEqual(reply, { ok: false, code: "missing_arg", message: "result needs an outcome" });
});

test("a call with a wrong or old attempt secret is refused", async (t) => {
  const rig = await newRig();
  t.after(() => rig.owner.close());

  await startAttempt(rig, "001-review", "review");
  const { socketPath, endpoint } = await serveResult(rig, "001-review", "current-secret", [
    "approved",
  ]);
  t.after(() => endpoint.close());

  const report = await reportResult(
    { endpoint: socketPath, attemptId: "001-review", secret: "guessed" },
    "approved",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test.after(() => rm(scratch, { recursive: true, force: true }));
