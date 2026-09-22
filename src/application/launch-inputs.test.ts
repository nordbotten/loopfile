import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAgainstDeclared,
  decodeLaunch,
  encodeLaunch,
  type LaunchRequest,
  parseInputFlags,
} from "./launch-inputs.ts";

test("flags become a map, and the value keeps every `=` after the first", () => {
  assert.deepEqual(parseInputFlags(["issue=42", "q=a=b", "empty="]), {
    ok: true,
    inputs: { issue: "42", q: "a=b", empty: "" },
  });
  assert.deepEqual(parseInputFlags([]), { ok: true, inputs: {} });
});

test("a flag with no `=` is refused", () => {
  const result = parseInputFlags(["issue"]);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /<name>=<value>/);
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
  assert.match(!result.ok ? result.message : "", /more than once/);
});

test("given inputs must match the declared ones exactly", () => {
  const declared = { issue: "The issue number", repo: "The repo" };
  assert.deepEqual(checkAgainstDeclared({ issue: "1", repo: "x" }, declared).ok, true);

  const undeclared = checkAgainstDeclared({ issue: "1", repo: "x", other: "y" }, declared);
  assert.equal(undeclared.ok, false);
  assert.match(!undeclared.ok ? undeclared.message : "", /other is not declared.*issue, repo/);

  const none = checkAgainstDeclared({ other: "y" }, {});
  assert.match(!none.ok ? none.message : "", /takes no inputs/);

  const missing = checkAgainstDeclared({ issue: "1" }, declared);
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.message : "", /missing --input for repo/);
  assert.match(!missing.ok ? missing.message : "", /issue: The issue number\n {2}repo: The repo/);

  assert.deepEqual(checkAgainstDeclared({}, {}), { ok: true, inputs: {} });
});

test("a launch request survives the environment variable", () => {
  const request: LaunchRequest = {
    source: "-",
    kind: "thin",
    sourceText: "formatVersion: 1",
    repository: "/r",
    inputs: { a: "1" },
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
  ];
  for (const text of bad) assert.equal(decodeLaunch(text), undefined, text);
  assert.notEqual(decodeLaunch(JSON.stringify(good)), undefined);
});
