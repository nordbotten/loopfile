import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../domain/events.ts";
import { historyEntries, promptDataView, renderPrompt, valueSources } from "./prompt-fill.ts";

const put = (attemptId: string, key: string, extra: object = {}) =>
  ({
    type: "data.put",
    attemptId,
    key,
    size: 1,
    digest: "d",
    seq: 1,
    at: "t",
    ...extra,
  }) as RunEvent;

test("a key used twice is filled in both places", () => {
  assert.equal(renderPrompt("{{ a.b }}-{{a.b}}", promptDataView(new Map([["a.b", "X"]]))), "X-X");
});

test("renderPrompt finds flat data keys through its nested prompt data view without escaping", () => {
  const view = promptDataView(new Map([["test.log", "<>&\"'"]]));
  assert.equal(renderPrompt("{{ test.log }}", view), "<>&\"'");
});

test("this renders each scalar item", () => {
  const view = promptDataView(
    new Map([
      ["review.feedback", "yes"],
      ["review.other", "no"],
    ]),
  );
  assert.equal(renderPrompt("{{#each review}}{{this}}|{{/each}}", view), "yes|no|");
});

test("a key with no value fills as an empty string", () => {
  assert.equal(
    renderPrompt("[{{ a.b }}][{{ c.d }}]", promptDataView(new Map([["c.d", "v"]]))),
    "[][v]",
  );
});

test("data keys named like Object members are treated as own properties", () => {
  assert.equal(
    renderPrompt("{{ constructor.out }}", promptDataView(new Map([["constructor.out", "v"]]))),
    "v",
  );
});

test("data keys named like Handlebars syntax are treated as literal segments", () => {
  const values = new Map([
    ["this.out", "this-value"],
    ["plan.this", "plan-value"],
    ["else.x", "else-value"],
  ]);
  assert.equal(
    renderPrompt("{{ this.out }}|{{ plan.this }}|{{ else.x }}", promptDataView(values)),
    "this-value|plan-value|else-value",
  );
});

test("a value that holds a placeholder is not filled again", () => {
  const values = new Map([
    ["a.b", "{{ x.y }}"],
    ["x.y", "no"],
  ]);
  assert.equal(renderPrompt("{{ a.b }}", promptDataView(values)), "{{ x.y }}");
});

test("a value with a dollar sign is inserted as it is", () => {
  assert.equal(renderPrompt("{{ a.b }}", promptDataView(new Map([["a.b", "$& $1"]]))), "$& $1");
});

test("a prompt with no placeholder is unchanged", () => {
  assert.equal(renderPrompt("plain", promptDataView(new Map())), "plain");
});

test("a history list renders as stable JSON", () => {
  const entries = [
    {
      value: "first",
      attemptId: "001-review",
      outcome: "changes_requested",
      index: 1,
      newest: false,
      new: false,
    },
    {
      value: "second",
      attemptId: "003-review",
      outcome: "changes_requested",
      index: 2,
      newest: true,
      new: true,
    },
  ];
  const view = promptDataView(new Map([["$history.review.feedback", entries]]));
  const expected = JSON.stringify(entries, null, 2);
  assert.equal(renderPrompt("{{ $history.review.feedback }}", view), expected);
  assert.equal(renderPrompt("{{ $history.review.feedback }}", view), expected);
});

test("history entries include attempt outcomes and values new since this step's prior attempt", () => {
  const history = [
    {
      type: "attempt.started",
      attemptId: "001-implement",
      stepId: "implement",
      processGroupId: 1,
      seq: 1,
      at: "t",
    },
    put("002-review", "review.feedback", { seq: 2 }),
    {
      type: "attempt.ended",
      attemptId: "002-review",
      result: "success",
      reason: "outcome",
      outcome: "changes_requested",
      seq: 3,
      at: "t",
    },
    {
      type: "attempt.started",
      attemptId: "003-implement",
      stepId: "implement",
      processGroupId: 1,
      seq: 4,
      at: "t",
    },
    put("004-review", "review.feedback", { seq: 5 }),
  ] as RunEvent[];
  assert.deepEqual(
    historyEntries(
      history,
      "implement",
      "005-implement",
      "review.feedback",
      [
        { kind: "attempt", attemptId: "002-review" },
        { kind: "attempt", attemptId: "004-review" },
      ],
      ["old", "new"],
    ),
    [
      {
        value: "old",
        attemptId: "002-review",
        outcome: "changes_requested",
        index: 1,
        newest: false,
        new: false,
      },
      { value: "new", attemptId: "004-review", outcome: "", index: 2, newest: true, new: true },
    ],
  );
});

test("valueSources gives the input file for input.*, even with no events", () => {
  assert.deepEqual(valueSources([], "input.topic"), [{ kind: "input", name: "topic" }]);
});

test("valueSources gives nothing for a key never put", () => {
  assert.deepEqual(valueSources([], "a.b"), []);
});

test("valueSources gives only the newest put for a put key", () => {
  const history = [put("001-a", "a.b"), put("002-a", "a.b"), put("002-a", "a.c")];
  const sources = valueSources(history, "a.b");
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.kind === "attempt" && sources[0].attemptId, "002-a");
});

test("valueSources gives every append, oldest first, each with its writeIndex", () => {
  const history = [
    put("001-a", "a.b", { appended: true, writeIndex: 0 }),
    put("001-a", "a.c", { appended: true, writeIndex: 0 }),
    put("001-a", "a.b", { appended: true, writeIndex: 1 }),
    put("002-a", "a.b", { appended: true, writeIndex: 0 }),
  ];
  assert.deepEqual(valueSources(history, "a.b"), [
    { kind: "attempt", attemptId: "001-a", writeIndex: 0 },
    { kind: "attempt", attemptId: "001-a", writeIndex: 1 },
    { kind: "attempt", attemptId: "002-a", writeIndex: 0 },
  ]);
});

test("valueSources leaves writeIndex out for an append event that has none", () => {
  const history = [put("001-a", "a.b", { appended: true })];
  assert.deepEqual(valueSources(history, "a.b"), [{ kind: "attempt", attemptId: "001-a" }]);
});
