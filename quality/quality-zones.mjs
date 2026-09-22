/**
 * The zone map: what every tracked source file under `src/` means (ADR 0009).
 *
 * Every quality tool reads this module, so one file has exactly one zone and
 * the import rule, the coverage globs and the bars can never disagree about it.
 *
 * Files come from `git ls-files`, never from a glob. Git already knows what
 * belongs to the project, including the local exclusions that keep an agent's
 * worktree under `.claude/worktrees/` out of the way.
 *
 * Run directly to check the map against the working tree.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/** The repository root, so a check gives the same answer from any directory. */
export const REPO_ROOT = resolve(dirname(import.meta.dirname));

/**
 * A source file's zone.
 *
 * `CORE` is pure logic: the workflow model, the loader, routing and the run
 * owner's decisions. `BOUNDARY` is the explicit side-effect edge. `EXEMPT` is
 * the CLI entry point. `TESTS` is an exclusion, not a measured zone.
 *
 * @typedef {"CORE" | "BOUNDARY" | "EXEMPT" | "TESTS"} Zone
 */

/**
 * First match wins. A `src/*.ts` that matches nothing is `CORE`, the strictest
 * zone, so a file that cannot honour the import rule has to move under
 * `src/adapters/` rather than argue with the map.
 *
 * @type {[RegExp, Zone][]}
 */
const RULES = [
  [/^src\/.*\.test\.ts$/, "TESTS"],
  [/^src\/adapters\//, "BOUNDARY"],
  // Argument parsing and process wiring only. Holds no logic worth measuring.
  [/^src\/cli\.ts$/, "EXEMPT"],
];

/** Top-level directories under `src/` the map knows. A new one is a decision. */
const KNOWN_DIRECTORIES = new Set(["adapters", "application", "domain"]);

/**
 * Every TypeScript file under `src/` the project owns, repository-relative.
 *
 * `--others` includes a file that is written but not yet staged, so a new file
 * is checked before it is committed rather than after. `--exclude-standard`
 * keeps git's own exclusions, which is what leaves an agent's worktree under
 * `.claude/worktrees/` out. `--deduplicate` stops a staged file appearing twice.
 */
export function sourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", "src"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return output.split("\n").filter((file) => file.endsWith(".ts"));
}

/**
 * The zone of one repository-relative file, or `null` when the map does not
 * classify it. Only an unknown top-level directory under `src/` is unclassified.
 *
 * @param {string} file
 * @returns {Zone | null}
 */
export function zoneOf(file) {
  const segments = file.split("/");
  if (segments.length > 2 && !KNOWN_DIRECTORIES.has(segments[1])) return null;
  for (const [pattern, zone] of RULES) {
    if (pattern.test(file)) return zone;
  }
  return "CORE";
}

/**
 * Every tracked file in one zone.
 *
 * @param {Zone} zone
 */
export function filesInZone(zone) {
  return sourceFiles().filter((file) => zoneOf(file) === zone);
}

/** Checks that every tracked source file has a zone. Returns the exit code. */
export function main(write) {
  const counts = { CORE: 0, BOUNDARY: 0, EXEMPT: 0, TESTS: 0 };
  const unclassified = [];
  for (const file of sourceFiles()) {
    const zone = zoneOf(file);
    if (zone === null) unclassified.push(file);
    else counts[zone] += 1;
  }

  if (unclassified.length > 0) {
    write("Unclassified source files:\n");
    for (const file of unclassified) write(`  ${file}\n`);
    write(
      "\nEach one sits in a directory under src/ the zone map does not know.\n" +
        "Classify it in quality/quality-zones.mjs, or move it under\n" +
        "src/domain/, src/application/ or src/adapters/.\n",
    );
    return 1;
  }

  const summary = Object.entries(counts)
    .map(([zone, count]) => `${zone} ${count}`)
    .join(", ");
  write(`zones: every source file classified (${summary})\n`);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main((text) => process.stdout.write(text));
}
