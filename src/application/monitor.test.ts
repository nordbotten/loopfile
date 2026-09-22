import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters, styleText } from "node:util";
import type { StatusProjection } from "../domain/status.ts";
import { DETACH_HINT, type MonitorView, notTerminalMessage, renderMonitor } from "./monitor.ts";
import { ownerGoneMessage } from "./tail.ts";

const RUN = "20260918-100000-abcd";
const START = "2026-09-18T10:00:00.000Z";
const NOW = "2026-09-18T10:01:05.000Z";

function status(overrides: Partial<StatusProjection> = {}): StatusProjection {
  return {
    formatVersion: 1,
    seq: 7,
    updatedAt: NOW,
    runId: RUN,
    loopfileName: "fix-bugs",
    state: "running",
    endReason: null,
    startedAt: START,
    endedAt: null,
    current: {
      stepId: "build",
      stepKind: "agent",
      attemptId: "a1",
      attempt: 2,
      maxAttempts: 3,
      iteration: null,
      maxIterations: null,
      harness: "claude",
      startedAt: START,
    },
    lastActivityAt: "2026-09-18T10:01:00.000Z",
    lastProgress: "editing files",
    visitedSteps: [
      { stepId: "plan", attempts: 1 },
      { stepId: "build", attempts: 2 },
    ],
    lastTransition: { from: "plan", to: "build", cause: "on", outcome: "done" },
    transitions: 3,
    maxTransitions: 20,
    metrics: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 1.5, toolCalls: 4 },
    ...overrides,
  } as StatusProjection;
}

function render(view: MonitorView, now = NOW): string {
  return stripVTControlCharacters(renderMonitor(view, now));
}

test("a live view shows every line in order", () => {
  assert.equal(
    render({ kind: "live", status: status() }),
    [
      `run       ${RUN} · fix-bugs`,
      "state     running · 1:05",
      "step      build (agent, claude) · attempt 2/3",
      "activity  0:05 ago · editing files",
      "metrics   tokens 150 (in 100 / out 50) · cost $1.50 · tool calls 4",
      "route     plan → build (done) · transitions 3/20",
      "visited   plan ×1, build ×2",
      DETACH_HINT,
      "",
    ].join("\n"),
  );
});

test("null metrics show unknown and 0 shows 0", () => {
  const nulls = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    toolCalls: null,
  };
  const text = render({ kind: "live", status: status({ metrics: nulls }) });
  assert.equal(text.match(/unknown/g)?.length, 5);
  const zeros = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, toolCalls: 0 };
  assert.match(
    render({ kind: "live", status: status({ metrics: zeros }) }),
    /tokens 0 \(in 0 \/ out 0\) · cost \$0\.00 · tool calls 0/,
  );
});

test("activity age grows with the clock and resets on new activity", () => {
  const view: MonitorView = { kind: "live", status: status() };
  assert.match(render(view, "2026-09-18T10:01:35.000Z"), /activity {2}0:35 ago/);
  const fresh: MonitorView = {
    kind: "live",
    status: status({ lastActivityAt: "2026-09-18T10:01:34.000Z" }),
  };
  assert.match(render(fresh, "2026-09-18T10:01:35.000Z"), /activity {2}0:01 ago/);
});

test("no progress yet, no route and no limit have their own text", () => {
  const text = render({
    kind: "live",
    status: status({
      lastProgress: null,
      lastTransition: null,
      current: null,
      maxTransitions: null,
    }),
  });
  assert.match(text, /activity {2}0:05 ago · no progress yet/);
  assert.match(text, /^step {6}- \(between steps\)$/m);
  assert.match(text, /^route {5}-$/m);
  const limited = render({
    kind: "live",
    status: status({
      maxTransitions: null,
      lastTransition: { from: "a", to: "b", cause: "next", outcome: null },
    }),
  });
  assert.match(limited, /a → b \(next\) · transitions 3\/no limit/);
});

test("a Ralph step shows the iteration and a command step shows neither harness nor iteration", () => {
  const ralph = status({
    current: {
      stepId: "loop",
      stepKind: "ralph",
      attemptId: "a",
      attempt: 1,
      maxAttempts: 2,
      iteration: 4,
      maxIterations: 10,
      harness: "pi",
      startedAt: START,
    },
  });
  assert.match(
    render({ kind: "live", status: ralph }),
    /loop \(ralph, pi\) · attempt 1\/2 · iteration 4\/10/,
  );
  const command = status({
    current: {
      stepId: "test",
      stepKind: "command",
      attemptId: "a",
      attempt: 1,
      maxAttempts: 2,
      iteration: null,
      maxIterations: null,
      harness: null,
      startedAt: START,
    },
  });
  assert.match(
    render({ kind: "live", status: command }),
    /^step {6}test \(command\) · attempt 1\/2$/m,
  );
});

test("an ended view has the end reason, no step line and no hint", () => {
  const failed = render({
    kind: "ended",
    status: status({
      state: "failed",
      endReason: "attempt_limit",
      endedAt: "2026-09-18T10:00:30.000Z",
      current: null,
    }),
  });
  assert.match(failed, /^state {5}failed \(attempt_limit\)$/m);
  assert.doesNotMatch(failed, /^step/m);
  assert.doesNotMatch(failed, new RegExp(DETACH_HINT));
  const done = render({
    kind: "ended",
    status: status({ state: "completed", endReason: "success", endedAt: START }),
  });
  assert.match(done, /^state {5}completed \(success\)$/m);
});

test("a crashed view says the owner is gone and has no hint", () => {
  const withStatus = render({ kind: "crashed", runId: RUN, status: status() });
  assert.match(withStatus, new RegExp(`^state {5}crashed · ${ownerGoneMessage(RUN)}$`, "m"));
  assert.match(withStatus, /^step /m);
  assert.doesNotMatch(withStatus, new RegExp(DETACH_HINT));
  const bare = render({ kind: "crashed", runId: RUN, status: undefined });
  assert.equal(bare, `state     crashed · ${ownerGoneMessage(RUN)}\n`);
});

test("a waiting view has one line and the hint", () => {
  assert.equal(
    render({ kind: "waiting", runId: RUN }),
    `waiting for run ${RUN} to write status.json\n${DETACH_HINT}\n`,
  );
});

test("an unknown view shows unknown, not running, and keeps the hint", () => {
  const text = render({ kind: "unknown", status: status() });
  assert.match(text, /^state {5}unknown · 1:05$/m);
  assert.match(text, new RegExp(DETACH_HINT));
});

test("the state word goes through styleText bold", () => {
  const text = renderMonitor({ kind: "live", status: status() }, NOW);
  assert.ok(text.includes(`state     ${styleText("bold", "running")} · 1:05`));
});

test("the not-a-terminal message names status and tail", () => {
  const message = notTerminalMessage(RUN);
  assert.match(message, new RegExp(`loopfile status ${RUN}`));
  assert.match(message, new RegExp(`loopfile tail ${RUN}`));
});
