import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document } from "yaml";
import { FORMAT_VERSION } from "../domain/model.ts";
import {
  MANIFEST_UPGRADES,
  type ManifestUpgrades,
  parseUpgradeAnswer,
  planUpgrade,
  renderManifestDiff,
} from "./upgrade.ts";

const rename =
  (from: string, to: string) =>
  (doc: Document): void => {
    const value = doc.get(from);
    doc.delete(from);
    doc.set(to, value);
  };

const UPGRADES: ManifestUpgrades = { 0: rename("oldSteps", "steps") };

const V0 = "# keep me\nformatVersion: 0\noldSteps: []\n";

test("version 0 upgrades to version 1, keeps the comment and renames the field", () => {
  const plan = planUpgrade(V0, UPGRADES);
  assert.equal(plan.kind, "upgrade");
  assert.equal(plan.kind === "upgrade" && plan.from, 0);
  assert.equal(plan.kind === "upgrade" && plan.text, "# keep me\nformatVersion: 1\nsteps: []\n");
});

test("versions 1 and 2, a missing or text version and non-YAML are not older", () => {
  for (const text of [
    "formatVersion: 1\n",
    "formatVersion: 2\n",
    "steps: []\n",
    'formatVersion: "0"\n',
    "formatVersion: 0.5\n",
    "- formatVersion: 0\n",
    "a: [unclosed\n",
  ]) {
    assert.deepEqual(planUpgrade(text, UPGRADES), { kind: "not_older" }, text);
  }
});

test("every older format version has an upgrade step", () => {
  for (let version = 1; version < FORMAT_VERSION; version++) {
    assert.equal(typeof MANIFEST_UPGRADES[version], "function", `missing step from ${version}`);
  }
});

test("two steps run in order and the tool sets formatVersion itself", () => {
  const order: string[] = [];
  const plan = planUpgrade("formatVersion: -1\n", {
    [-1]: (doc) => {
      order.push(`-1 sees ${doc.get("formatVersion")}`);
      doc.set("a", 1);
    },
    0: (doc) => {
      order.push(`0 sees ${doc.get("formatVersion")}`);
      doc.set("b", 2);
    },
  });
  assert.deepEqual(order, ["-1 sees -1", "0 sees 0"]);
  assert.deepEqual(plan, { kind: "upgrade", from: -1, text: "formatVersion: 1\na: 1\nb: 2\n" });
});

test("the diff marks removed, added and unchanged lines", () => {
  assert.equal(
    renderManifestDiff("a: 1\noldSteps: []\n", "a: 1\nsteps: []\n"),
    "  a: 1\n- oldSteps: []\n+ steps: []\n",
  );
});

test("the same text twice has no removed or added line", () => {
  const same = renderManifestDiff("a: 1\nb: 2\n", "a: 1\nb: 2\n");
  assert.equal(same, "  a: 1\n  b: 2\n");
});

test("answers: empty, y and yes in any case mean yes", () => {
  for (const a of ["", "  ", "y", "Y", "yes", " YeS "]) assert.equal(parseUpgradeAnswer(a), "yes");
});

test("answers: n and no in any case, and end of input, mean no", () => {
  for (const a of ["n", "N", "no", " No ", null]) assert.equal(parseUpgradeAnswer(a), "no");
});

test("any other answer asks again", () => {
  for (const a of ["maybe", "yy", "nope", "1"]) assert.equal(parseUpgradeAnswer(a), "again");
});
