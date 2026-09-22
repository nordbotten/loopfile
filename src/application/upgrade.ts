/**
 * The manifest upgrade path (#65, ADR 0006).
 *
 * A table maps a format version N to a step that makes N+1. `planUpgrade` applies
 * the steps in order until the current version and returns the new text. The
 * prompt and `loopfile upgrade` both call it, so they cannot disagree. A step
 * edits the YAML document in place, so comments, key order and quotes stay and
 * the diff shows only what the upgrade changed (D1).
 */

import { diff } from "node:util";
import { type Document, isMap, parseDocument } from "yaml";
import { FORMAT_VERSION } from "../domain/model.ts";

/** Changes a manifest from version N to N+1 in place. It never sets `formatVersion`. */
export type ManifestUpgrade = (manifest: Document) => void;
/** Key N upgrades N to N+1. */
export type ManifestUpgrades = Readonly<Record<number, ManifestUpgrade>>;
/** Each entry upgrades one released format version to the next. */
export const MANIFEST_UPGRADES: ManifestUpgrades = {};

export type UpgradePlan =
  /** Missing, not an integer, current, newer, or not YAML: the loader handles it. */
  | { readonly kind: "not_older" }
  | { readonly kind: "upgrade"; readonly from: number; readonly text: string };

/** Works out what upgrading `text` to the current format version means. */
export function planUpgrade(
  text: string,
  upgrades: ManifestUpgrades = MANIFEST_UPGRADES,
): UpgradePlan {
  const document = parseDocument(text);
  const from = document.errors.length === 0 ? readVersion(document) : undefined;
  if (from === undefined || from >= FORMAT_VERSION) return { kind: "not_older" };

  for (let version = from; version < FORMAT_VERSION; version++) {
    const step = upgrades[version];
    if (step === undefined) throw new Error(`missing upgrade step from format version ${version}`);
    step(document);
    document.set("formatVersion", version + 1);
  }
  return { kind: "upgrade", from, text: document.toString() };
}

/** The top-level `formatVersion` when it is an integer. */
function readVersion(document: Document): number | undefined {
  if (!isMap(document.contents)) return undefined;
  const version = document.get("formatVersion");
  return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

/** Every line of both texts: `- ` removed, `+ ` added, two spaces unchanged. */
export function renderManifestDiff(oldText: string, newText: string): string {
  const marks: Record<number, string> = { 1: "- ", [-1]: "+ ", 0: "  " };
  return diff(lines(oldText), lines(newText))
    .map(([op, line]) => `${marks[op]}${line}\n`)
    .join("");
}

function lines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** What an answer to `Upgrade? [Y/n]` means. `null` is the end of input. */
export function parseUpgradeAnswer(answer: string | null): "yes" | "no" | "again" {
  if (answer === null) return "no";
  const word = answer.trim().toLowerCase();
  if (word === "" || word === "y" || word === "yes") return "yes";
  if (word === "n" || word === "no") return "no";
  return "again";
}
