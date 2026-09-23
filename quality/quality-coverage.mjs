/**
 * Coverage bars per zone, and a CRAP score per function (ADR 0009).
 *
 * One run of the suite answers both questions, so they live in one check.
 * Coverage asks whether the code runs under test. CRAP asks a sharper version
 * of the same question: a function that is both complicated and thinly covered
 * scores badly, and the only ways down are more tests or less branching.
 *
 *   CRAP = complexity^2 * (1 - coverage)^3 + complexity
 *
 * `EXEMPT` is not measured. `TESTS` is not measured. The bars live in
 * `quality-ratchet.json` and nowhere else.
 *
 * Coverage comes from c8 in Istanbul format rather than V8's own, because CRAP
 * needs per-function statement data that only the Istanbul report carries.
 *
 * Run directly to check the working tree.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, zoneOf } from "./quality-zones.mjs";

/** Zones that have coverage bars. Every other zone is not measured. */
const MEASURED = ["CORE", "BOUNDARY"];

/** Where c8 writes the Istanbul report this check reads. */
const REPORT = "coverage/coverage-final.json";

/** Runs the suite under c8. Throws with the suite's own output if it fails. */
function collectCoverage() {
  execFileSync(
    "npx",
    [
      "c8",
      "--reporter=json",
      "--src=src",
      "--all",
      "--exclude=**/*.test.ts",
      "--exclude=quality/**",
      "node",
      "--test",
      "--test-timeout=120000",
      "src/**/*.test.ts",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** True when `point` falls inside `range`, comparing line then column. */
function within(point, range) {
  if (point.line < range.start.line || point.line > range.end.line) return false;
  if (point.line === range.start.line && point.column < range.start.column) return false;
  if (point.line === range.end.line && point.column > range.end.column) return false;
  return true;
}

/** Statement, branch, function and line tallies for one file's report. */
function tally(report) {
  const counts = {
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };

  const lineHits = new Map();
  for (const [id, location] of Object.entries(report.statementMap)) {
    const hits = report.s[id];
    counts.statements.total += 1;
    if (hits > 0) counts.statements.covered += 1;
    const line = location.start.line;
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
  }
  for (const hits of lineHits.values()) {
    counts.lines.total += 1;
    if (hits > 0) counts.lines.covered += 1;
  }
  for (const id of Object.keys(report.fnMap)) {
    counts.functions.total += 1;
    if (report.f[id] > 0) counts.functions.covered += 1;
  }
  for (const hitsPerPath of Object.values(report.b)) {
    for (const hits of hitsPerPath) {
      counts.branches.total += 1;
      if (hits > 0) counts.branches.covered += 1;
    }
  }
  return counts;
}

/** A percentage, where nothing to measure counts as fully covered. */
function percent({ covered, total }) {
  return total === 0 ? 100 : (covered / total) * 100;
}

/** How many lines a range spans, used to find the innermost enclosing function. */
function span(range) {
  return (range.end.line - range.start.line) * 1000 + (range.end.column - range.start.column);
}

/**
 * The function a point belongs to: the innermost one that contains it.
 *
 * A callback written inside another function is its own function, with its own
 * score. Without this, every branch in a nested arrow would be charged twice,
 * once to the arrow and again to whatever it was written inside.
 */
function owningFunction(point, functions) {
  let owner = null;
  for (const fn of functions) {
    if (!within(point, fn.loc)) continue;
    if (owner === null || span(fn.loc) < span(owner.loc)) owner = fn;
  }
  return owner;
}

/**
 * The CRAP score of every function in one file's report.
 *
 * Complexity is read from the branches the function owns, which is what an
 * Istanbul report can tell us: one path beyond the first is one more way
 * through. Coverage is the share of the statements it owns that ran.
 */
export function crapScores(report) {
  const functions = Object.entries(report.fnMap).map(([id, fn]) => ({ id, ...fn }));
  const owned = new Map(functions.map((fn) => [fn.id, { covered: 0, total: 0, complexity: 1 }]));

  for (const [statementId, location] of Object.entries(report.statementMap)) {
    const owner = owningFunction(location.start, functions);
    if (owner === null) continue;
    const counts = owned.get(owner.id);
    counts.total += 1;
    if (report.s[statementId] > 0) counts.covered += 1;
  }

  // c8 reports one entry per branch *path*, not one per decision. Two of those
  // paths are not decisions: a `column: -1` entry stands for the else an `if`
  // never wrote, and each function carries one entry at its own start. Dropping
  // both leaves one entry per decision, which is what complexity counts.
  const functionStarts = new Set(
    functions.map((fn) => `${fn.loc.start.line}:${fn.loc.start.column}`),
  );
  for (const branch of Object.values(report.branchMap)) {
    const { line, column } = branch.loc.start;
    if (column === -1 || functionStarts.has(`${line}:${column}`)) continue;
    const owner = owningFunction(branch.loc.start, functions);
    if (owner === null) continue;
    owned.get(owner.id).complexity += 1;
  }

  return functions.map((fn) => {
    const { covered, total, complexity } = owned.get(fn.id);
    const coverage = total === 0 ? 1 : covered / total;
    const crap = complexity ** 2 * (1 - coverage) ** 3 + complexity;
    return { name: fn.name, line: fn.decl.start.line, complexity, coverage, crap };
  });
}

/** Checks coverage bars and CRAP scores. Returns the exit code. */
export function main(write) {
  const bars = JSON.parse(readFileSync(join(REPO_ROOT, "quality/quality-ratchet.json"), "utf8"));

  try {
    collectCoverage();
  } catch (error) {
    write("The test suite failed, so there is nothing to measure.\n\n");
    write(error.stdout ?? "");
    write(error.stderr ?? "");
    return 1;
  }

  const report = JSON.parse(readFileSync(join(REPO_ROOT, REPORT), "utf8"));
  const zoneCounts = new Map(MEASURED.map((zone) => [zone, []]));
  const failures = [];
  const crapFailures = [];
  let worstCrap = { crap: 0 };

  for (const [absolute, fileReport] of Object.entries(report)) {
    const file = relative(REPO_ROOT, absolute);
    const zone = zoneOf(file);
    if (!zoneCounts.has(zone)) continue;
    zoneCounts.get(zone).push(tally(fileReport));

    for (const score of crapScores(fileReport)) {
      if (score.crap > worstCrap.crap) worstCrap = { ...score, file };
      if (score.crap > bars.crap.max) crapFailures.push({ ...score, file });
    }
  }

  for (const zone of MEASURED) {
    const files = zoneCounts.get(zone);
    const totals = {};
    for (const metric of ["statements", "branches", "functions", "lines"]) {
      totals[metric] = files.reduce(
        (sum, counts) => ({
          covered: sum.covered + counts[metric].covered,
          total: sum.total + counts[metric].total,
        }),
        { covered: 0, total: 0 },
      );
    }

    const reported = [];
    for (const [metric, bar] of Object.entries(bars.coverage[zone])) {
      const actual = percent(totals[metric]);
      reported.push(`${metric} ${actual.toFixed(1)}%`);
      if (actual < bar) failures.push(`${zone} ${metric} ${actual.toFixed(1)}% < ${bar}%`);
    }
    write(`  ${zone.padEnd(8)} ${reported.join(", ")}\n`);
  }

  write(
    `  CRAP     worst ${worstCrap.crap.toFixed(1)} ` +
      `(${worstCrap.file ?? "none"}:${worstCrap.line ?? 0} ${worstCrap.name ?? ""}), ` +
      `bar ${bars.crap.max}\n`,
  );

  if (failures.length > 0 || crapFailures.length > 0) {
    write("\n");
    for (const failure of failures) write(`coverage below bar: ${failure}\n`);
    for (const { file, line, name, crap, complexity, coverage } of crapFailures) {
      write(
        `CRAP above bar: ${file}:${line} ${name} scores ${crap.toFixed(1)} ` +
          `(complexity ${complexity}, coverage ${(coverage * 100).toFixed(0)}%)\n`,
      );
    }
    write("\nCover the code, or make the function simpler. The bars only move up.\n");
    return 1;
  }

  write("coverage: every measured zone is above its bar, and no function is CRAP\n");
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main((text) => process.stdout.write(text));
}
