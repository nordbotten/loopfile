import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesTrust, parseTrustList } from "./trust.ts";

test("trust-list parsing table", () => {
  const cases = [
    ["missing file", undefined, { status: "ok", repos: [], owners: [] }],
    ["empty lists", "formatVersion: 1\n", { status: "ok", repos: [], owners: [] }],
    [
      "missing repos",
      "formatVersion: 1\nowners: [gitlab.com/team]\n",
      { status: "ok", repos: [], owners: ["gitlab.com/team"] },
    ],
    [
      "missing owners",
      "formatVersion: 1\nrepos: [GitHub.com/A/B]\n",
      { status: "ok", repos: ["github.com/a/b"], owners: [] },
    ],
    [
      "declared lists",
      "formatVersion: 1\nrepos: [GitHub.com/A/B]\nowners: [gitlab.com/team]\n",
      { status: "ok", repos: ["github.com/a/b"], owners: ["gitlab.com/team"] },
    ],
    ["bad YAML", "formatVersion: [\n", { status: "broken" }],
    ["root is not a map", "- formatVersion\n- 1\n", { status: "broken" }],
    ["wrong format version", "formatVersion: 2\n", { status: "broken" }],
    ["unknown top-level key", "formatVersion: 1\nother: []\n", { status: "broken" }],
    ["repos is not a list", "formatVersion: 1\nrepos: github.com/a/b\n", { status: "broken" }],
    ["owners is not a list", "formatVersion: 1\nowners: null\n", { status: "broken" }],
    ["repo entry is not a string", "formatVersion: 1\nrepos: [1]\n", { status: "broken" }],
    ["owner entry is not a string", "formatVersion: 1\nowners: [false]\n", { status: "broken" }],
  ] as const;

  for (const [name, text, expected] of cases) {
    const parsed = parseTrustList(text);
    assert.equal(parsed.status, expected.status, name);
    if (expected.status === "ok" && parsed.status === "ok") {
      assert.deepEqual([parsed.repos, parsed.owners], [expected.repos, expected.owners], name);
    }
  }
});

test("trust-list matching table", () => {
  const parsed = parseTrustList(`formatVersion: 1
repos:
  - GITHUB.COM/ACME/LOOPS
owners:
  - GitLab.com/a
`);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;

  const cases = [
    ["repo exact match", "github.com/acme/loops", true],
    ["repo must match the whole key", "github.com/acme/loops-extra", false],
    ["owner matches descendant", "gitlab.com/a/b/repo", true],
    ["owner does not match a partial segment", "gitlab.com/ab/x", false],
    ["key is compared lowercase", "GITLAB.COM/A/B/REPO", true],
    ["other host", "github.com/a/b/repo", false],
  ] as const;
  for (const [name, key, expected] of cases) {
    assert.equal(matchesTrust(parsed, key), expected, name);
  }
});
