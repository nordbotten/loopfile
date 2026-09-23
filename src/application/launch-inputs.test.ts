import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAgainstDeclared,
  decodeLaunch,
  encodeLaunch,
  type LaunchRequest,
  mergeInputSet,
  parseInputFlags,
  parseInputSet,
} from "./launch-inputs.ts";

test("flags become a map, and the value keeps every `=` after the first", () => {
  assert.deepEqual(parseInputFlags(["issue=42", "q=a=b", "empty="]), {
    ok: true,
    inputs: { issue: "42", q: "a=b", empty: "" },
  });
  assert.deepEqual(parseInputFlags([]), { ok: true, inputs: {} });
});

test("JSON input sets must be objects with string values", () => {
  assert.deepEqual(parseInputSet('{"issue":"42","empty":""}'), {
    ok: true,
    inputs: { issue: "42", empty: "" },
  });
  assert.deepEqual(parseInputSet("null"), {
    ok: false,
    messages: ["input set is not a JSON object"],
  });
  assert.deepEqual(parseInputSet('["42"]'), {
    ok: false,
    messages: ["input set is not a JSON object"],
  });
  assert.deepEqual(parseInputSet('{"issue":42,"other":null}'), {
    ok: false,
    messages: ['input "issue" is not a string', 'input "other" is not a string'],
  });
  assert.deepEqual(parseInputSet("not json"), {
    ok: false,
    messages: ["input set is not valid JSON"],
  });
});

test("fixed and source input sets cannot share a name", () => {
  assert.deepEqual(mergeInputSet({ project: "loopfile" }, { issue: "42" }), {
    ok: true,
    inputs: { project: "loopfile", issue: "42" },
  });
  assert.deepEqual(mergeInputSet({ issue: "41", project: "loopfile" }, { issue: "42" }), {
    ok: false,
    messages: ['input "issue" is given by both --input and the input source'],
  });
});

test("a flag with no `=` is refused", () => {
  const result = parseInputFlags(["issue"]);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? (result.messages[0] ?? "") : "", /<name>=<value>/);
});

test("a name that breaks the ID rule is refused", () => {
  for (const flag of ["Issue=1", "1a=1", "=1", "a b=1", `${"a".repeat(65)}=1`]) {
    assert.equal(parseInputFlags([flag]).ok, false, flag);
  }
  assert.equal(parseInputFlags([`${"a".repeat(64)}=1`]).ok, true);
});

test("the same name twice is refused", () => {
  const result = parseInputFlags(["a=1", "a=2"]);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? (result.messages[0] ?? "") : "", /more than once/);
});

test("given inputs must match the declared ones exactly", () => {
  const declared = { issue: "The issue number", repo: "The repo" };
  assert.deepEqual(checkAgainstDeclared({ issue: "1", repo: "x" }, declared).ok, true);

  const undeclared = checkAgainstDeclared({ issue: "1", repo: "x", other: "y" }, declared);
  assert.equal(undeclared.ok, false);
  assert.deepEqual(!undeclared.ok ? undeclared.messages : [], [
    "--input other is not declared by the Loopfile. Declared inputs: issue, repo.",
  ]);

  const none = checkAgainstDeclared({ other: "y" }, {});
  assert.deepEqual(!none.ok ? none.messages : [], [
    "--input other is not declared by the Loopfile. The Loopfile takes no inputs.",
  ]);

  const missing = checkAgainstDeclared({ issue: "1" }, declared);
  assert.deepEqual(!missing.ok ? missing.messages : [], ["missing --input repo: The repo"]);

  assert.deepEqual(checkAgainstDeclared({}, {}), { ok: true, inputs: {} });
});

test("defaults fill omitted inputs and given values win", () => {
  const declared = { issue: "The issue number", merge: "Whether to merge" };
  const defaults = { merge: "no" };
  assert.deepEqual(checkAgainstDeclared({ issue: "42" }, declared, defaults), {
    ok: true,
    inputs: { issue: "42", merge: "no" },
  });
  assert.deepEqual(checkAgainstDeclared({ issue: "42", merge: "yes" }, declared, defaults), {
    ok: true,
    inputs: { issue: "42", merge: "yes" },
  });
  assert.deepEqual(
    checkAgainstDeclared({}, { issue: "The issue number", merge: "Whether to merge" }, defaults),
    {
      ok: false,
      messages: ["missing --input issue: The issue number"],
    },
  );
});

test("a launch request survives the environment variable", () => {
  const request: LaunchRequest = {
    source: "-",
    kind: "thin",
    sourceText: "formatVersion: 1",
    repository: "/r",
    inputs: { a: "1" },
    loopfileName: "loops",
    remote: {
      host: "github.com",
      repo: "acme/group/loops",
      path: "packages/loop",
      ref: "feature/ref",
      sha: "a".repeat(40),
    },
    loopId: "loop-20260922-105306-qfn3",
    loopIndex: 3,
  };
  assert.deepEqual(decodeLaunch(encodeLaunch(request)), request);
});

test("a launch request that is not one decodes to nothing", () => {
  const good = { source: "/s", kind: "thin", repository: "/r", inputs: {} };
  const bad = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...good, source: 1 }),
    JSON.stringify({ ...good, repository: 1 }),
    JSON.stringify({ ...good, kind: "zip" }),
    JSON.stringify({ ...good, sourceText: 1 }),
    JSON.stringify({ ...good, kind: "packed", sourceText: "manifest" }),
    JSON.stringify({ ...good, inputs: null }),
    JSON.stringify({ ...good, inputs: [] }),
    JSON.stringify({ ...good, inputs: { a: 1 } }),
    JSON.stringify({ ...good, loopfileName: 1 }),
    JSON.stringify({ ...good, remote: { host: "github.com", repo: "acme/loops", sha: "bad" } }),
    JSON.stringify({ ...good, loopId: 1 }),
    JSON.stringify({ ...good, loopIndex: 0 }),
    JSON.stringify({ ...good, loopIndex: 1.5 }),
  ];
  for (const text of bad) assert.equal(decodeLaunch(text), undefined, text);
  assert.notEqual(decodeLaunch(JSON.stringify(good)), undefined);
});
