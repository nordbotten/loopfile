import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_FORMAT_VERSION, type StatusProjection } from "../domain/status.ts";
import {
  buildRunList,
  deriveRunListEntry,
  isRunId,
  NO_RUNS_MESSAGE,
  renderRunList,
  sortRunListEntries,
  startedAtFromRunId,
} from "./run-list.ts";
import { UNKNOWN_METRICS } from "./status-projection.ts";

const RUN_ID = "20260917-160344-k3f7";

/** A minimal but complete v1 `StatusProjection`, overridable per test. */
function status(overrides: Partial<StatusProjection> = {}): StatusProjection {
  return {
    formatVersion: STATUS_FORMAT_VERSION,
    seq: 1,
    updatedAt: "2026-09-17T16:04:00.000Z",
    runId: RUN_ID,
    loopfileName: "review-loop",
    loopId: null,
    loopIndex: null,
    state: "running",
    endReason: null,
    startedAt: "2026-09-17T16:03:44.000Z",
    endedAt: null,
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

const NOW = "2026-09-17T16:10:00.000Z";

/** Built from `String.fromCharCode` rather than written literally, so no control character reaches the source. */
const ESC = String.fromCharCode(27);

function hasAnsi(text: string): boolean {
  return text.includes(ESC);
}

test("isRunId accepts the shape newRunId makes and rejects anything else", () => {
  assert.equal(isRunId(RUN_ID), true);
  assert.equal(isRunId("not-a-run-id"), false);
  assert.equal(isRunId("20260917-160344"), false);
  assert.equal(isRunId("20260917-160344-K3F9"), false);
});

test("startedAtFromRunId reads the timestamp a run ID carries", () => {
  assert.equal(startedAtFromRunId(RUN_ID), "2026-09-17T16:03:44.000Z");
});

test("startedAtFromRunId gives nothing for a folder name this tool never made", () => {
  assert.equal(startedAtFromRunId("some-other-folder"), undefined);
});

test("a run with no readable status.json is unreadable, with the run ID's own start time", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: undefined,
    ownerHost: undefined,
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  assert.deepEqual(entry, {
    runId: RUN_ID,
    loopfileName: null,
    state: "unreadable",
    currentStep: null,
    startedAt: "2026-09-17T16:03:44.000Z",
    elapsedMs: Date.parse(NOW) - Date.parse("2026-09-17T16:03:44.000Z"),
  });
});

test("an unreadable run whose folder name is not a run ID has no known start time", () => {
  const entry = deriveRunListEntry({
    runId: "leftover-folder",
    status: undefined,
    ownerHost: undefined,
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  assert.equal(entry.startedAt, null);
  assert.equal(entry.elapsedMs, null);
});

test("a completed run keeps its own state whatever the host and liveness say", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status({
      state: "completed",
      endReason: "success",
      endedAt: "2026-09-17T16:09:00.000Z",
    }),
    ownerHost: "some-other-host",
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  assert.equal(entry.state, "completed");
  assert.equal(
    entry.elapsedMs,
    Date.parse("2026-09-17T16:09:00.000Z") - Date.parse(status().startedAt),
  );
});

test("a running run whose owner still answers is running", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.equal(entry.state, "running");
});

test("a running run with no end event and a dead socket is crashed", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  assert.equal(entry.state, "crashed");
});

test("a running run whose last owner.started names another host is unknown, not crashed", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "some-other-host",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.equal(entry.state, "unknown");
});

test("a running run with no known owner host falls back to the liveness check", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: undefined,
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.equal(entry.state, "running");
});

test("currentStep is the open attempt's step when there is one", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status({
      current: {
        stepId: "implement",
        stepKind: "ralph",
        attemptId: "001-implement",
        attempt: 1,
        maxAttempts: 6,
        iteration: 2,
        maxIterations: 20,
        harness: "claude",
        startedAt: "2026-09-17T16:05:00.000Z",
      },
      visitedSteps: [{ stepId: "plan", attempts: 1 }],
    }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.equal(entry.currentStep, "implement");
});

test("currentStep falls back to the last visited step between attempts", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status({
      visitedSteps: [
        { stepId: "plan", attempts: 1 },
        { stepId: "implement", attempts: 2 },
      ],
    }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.equal(entry.currentStep, "implement");
});

test("currentStep is null before any step has been visited", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.equal(entry.currentStep, null);
});

test("sortRunListEntries puts every active run ahead of every ended one", () => {
  const running = deriveRunListEntry({
    runId: "20260917-100000-aaaa",
    status: status({ startedAt: "2026-09-17T10:00:00.000Z" }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  const ended = deriveRunListEntry({
    runId: "20260917-150000-bbbb",
    status: status({
      state: "completed",
      endReason: "success",
      startedAt: "2026-09-17T15:00:00.000Z",
      endedAt: "2026-09-17T15:05:00.000Z",
    }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.deepEqual(sortRunListEntries([ended, running]), [running, ended]);
});

test("sortRunListEntries sorts newest first within a group", () => {
  const older = deriveRunListEntry({
    runId: "20260917-090000-aaaa",
    status: status({
      state: "completed",
      endReason: "success",
      startedAt: "2026-09-17T09:00:00.000Z",
      endedAt: "2026-09-17T09:05:00.000Z",
    }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  const newer = deriveRunListEntry({
    runId: "20260917-150000-bbbb",
    status: status({
      state: "completed",
      endReason: "success",
      startedAt: "2026-09-17T15:00:00.000Z",
      endedAt: "2026-09-17T15:05:00.000Z",
    }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  assert.deepEqual(sortRunListEntries([older, newer]), [newer, older]);
});

test("sortRunListEntries puts a run with no known start time last in its group", () => {
  const unknownStart = deriveRunListEntry({
    runId: "leftover-folder",
    status: undefined,
    ownerHost: undefined,
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  const known = deriveRunListEntry({
    runId: RUN_ID,
    status: undefined,
    ownerHost: undefined,
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  assert.deepEqual(sortRunListEntries([unknownStart, known]), [known, unknownStart]);
});

test("buildRunList carries the list format version and the given rows", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  const list = buildRunList([entry]);
  assert.equal(list.formatVersion, 1);
  assert.deepEqual(list.runs, [entry]);
});

test("NO_RUNS_MESSAGE is a short, plain line", () => {
  assert.equal(NO_RUNS_MESSAGE, "no runs found\n");
});

test("renderRunList prints a header and one row per entry, with no ANSI when ansi is false", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  const text = renderRunList([entry], false);
  const lines = text.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 2);
  assert.match(lines[0] as string, /RUN ID/);
  assert.match(lines[1] as string, new RegExp(RUN_ID));
  assert.equal(hasAnsi(text), false);
});

test("renderRunList marks a running row in bold only when ansi is true", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status(),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: NOW,
  });
  const text = renderRunList([entry], true);
  assert.ok(text.includes(`${ESC}[1m`) && text.includes(`${ESC}[0m`));
});

test("renderRunList never bolds an ended row even with ansi on", () => {
  const entry = deriveRunListEntry({
    runId: RUN_ID,
    status: status({
      state: "completed",
      endReason: "success",
      endedAt: "2026-09-17T16:09:00.000Z",
    }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  const text = renderRunList([entry], true);
  assert.equal(hasAnsi(text), false);
});

test("renderRunList shows an unknown elapsed time as 'unknown'", () => {
  const entry = deriveRunListEntry({
    runId: "leftover-folder",
    status: undefined,
    ownerHost: undefined,
    thisHost: "host-a",
    alive: false,
    now: NOW,
  });
  const text = renderRunList([entry], false);
  assert.match(text, /unknown/);
});

test("renderRunList formats elapsed time as minutes:seconds under an hour, hours:minutes:seconds over one", () => {
  const short = deriveRunListEntry({
    runId: RUN_ID,
    status: status({ startedAt: "2026-09-17T16:08:00.000Z" }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: "2026-09-17T16:09:05.000Z",
  });
  assert.match(renderRunList([short], false), /1:05/);

  const long = deriveRunListEntry({
    runId: RUN_ID,
    status: status({ startedAt: "2026-09-17T13:00:00.000Z" }),
    ownerHost: "host-a",
    thisHost: "host-a",
    alive: true,
    now: "2026-09-17T16:09:05.000Z",
  });
  assert.match(renderRunList([long], false), /3:09:05/);
});
