/**
 * The quality tools check the codebase, so something has to check them.
 *
 * These tests cover the five pieces of real logic: which zone a path lands in,
 * which module specifiers `CORE` may not import, which text counts as a
 * suppression, how a CRAP score is read out of a coverage report, and which
 * lines mutation testing mutates. Each one
 * is tested on data, not on the working tree, so a green repository cannot hide
 * a check that never fires.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { crapScores } from "./quality-coverage.mjs";
import { forbiddenReason, importsOf } from "./quality-imports.mjs";
import { quietDiagnostics } from "./quality-runner.mjs";
import { findSuppressions } from "./quality-suppressions.mjs";
import { changedCore, REPO_ROOT, zoneOf } from "./quality-zones.mjs";
import strykerConfig from "./stryker.config.mjs";

/** A minimal Istanbul report shaped the way c8 writes one. */
function report({ statements = [], branches = [], functions = [] }) {
  const indexed = (entries) => Object.fromEntries(entries.map((entry, index) => [index, entry]));
  return {
    fnMap: indexed(functions.map(({ loc, name }) => ({ name, decl: loc, loc }))),
    f: indexed(functions.map(() => 1)),
    statementMap: indexed(statements.map(({ line }) => ({ start: { line, column: 2 } }))),
    s: indexed(statements.map(({ hits }) => hits)),
    branchMap: indexed(branches.map(({ line, column }) => ({ loc: { start: { line, column } } }))),
    b: indexed(branches.map(() => [1])),
  };
}

const wholeFile = { start: { line: 1, column: 0 }, end: { line: 99, column: 0 } };

test("Stryker excludes every tracked test that imports processes or the fake harness", () => {
  const files = execFileSync("git", ["ls-files", "--", "src"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".test.ts"));
  const included = new Set(strykerConfig.tap.testFiles);
  const processTests = files.filter((file) => {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const imports = [
      ...importsOf(source),
      ...Array.from(source.matchAll(/\bfrom\s*["']([^"']+)["']/g), (match) => match[1]),
    ];
    return imports.includes("node:child_process") || imports.includes("./fake-harness.test.ts");
  });

  assert.ok(processTests.length > 0);
  for (const file of processTests) {
    assert.ok(!included.has(file), `${file} should not run under Stryker`);
  }
});

test("the Coverage and CRAP docs separate source complexity from c8 coverage", () => {
  const docs = readFileSync(join(REPO_ROOT, "quality/QUALITY.md"), "utf8");
  const section = docs.split("## Coverage and CRAP\n")[1]?.split("\n## ")[0] ?? "";
  assert.match(section, /Complexity comes from the source/);
  assert.match(section, /Coverage comes from `c8`/);
});

test("the Mutation docs describe the Stryker process-test exclusions", () => {
  const docs = readFileSync(join(REPO_ROOT, "quality/QUALITY.md"), "utf8");
  const mutation = docs.split("## Mutation\n")[1]?.split("\n## ")[0] ?? "";
  assert.match(mutation, /`node:child_process`/);
  assert.match(mutation, /`\.\/fake-harness\.test\.ts`/);
  assert.match(mutation, /gate`\s+and `check` still run these files/);
});

test("the zone map places every kind of source file", () => {
  assert.equal(zoneOf("src/model.ts"), "CORE");
  assert.equal(zoneOf("src/domain/workflow.ts"), "CORE");
  assert.equal(zoneOf("src/application/launch.ts"), "CORE");
  assert.equal(zoneOf("src/adapters/ClaudeHarness.ts"), "BOUNDARY");
  assert.equal(zoneOf("src/adapters/input.ts"), "BOUNDARY");
  assert.equal(zoneOf("src/cli.ts"), "EXEMPT");
  assert.equal(zoneOf("src/model.test.ts"), "TESTS");
  assert.equal(zoneOf("src/adapters/ClaudeHarness.test.ts"), "TESTS");
});

test("a new flat source file defaults to CORE, the strictest zone", () => {
  assert.equal(zoneOf("src/loader.ts"), "CORE");
});

test("a source file in an unknown directory is unclassified", () => {
  assert.equal(zoneOf("src/ui/Monitor.ts"), null);
});

test("CORE may not reach the filesystem, processes, the network or a harness", () => {
  assert.equal(forbiddenReason("node:fs"), "the filesystem");
  assert.equal(forbiddenReason("node:fs/promises"), "the filesystem");
  assert.equal(forbiddenReason("node:child_process"), "processes");
  assert.equal(forbiddenReason("node:net"), "the network");
  assert.equal(forbiddenReason("@anthropic-ai/claude-agent-sdk"), "a harness SDK");
});

test("CORE may not import Handlebars' main entry or internals", () => {
  for (const specifier of ["handlebars", "handlebars/lib/index.js"]) {
    assert.equal(forbiddenReason(specifier), "the Handlebars main entry");
  }
  assert.equal(forbiddenReason("handlebars/dist/cjs/handlebars.js"), null);
});

test("CORE may reach pure standard-library modules and its own files", () => {
  for (const specifier of ["node:path", "node:util", "node:assert/strict", "./model.ts"]) {
    assert.equal(forbiddenReason(specifier), null, specifier);
  }
});

test("every import form is found, including dynamic and re-exported ones", () => {
  const source = [
    'import { open } from "node:fs/promises";',
    'import "./side-effect.ts";',
    'export { classifyInput } from "./input.ts";',
    'const mod = await import("node:child_process");',
    'const legacy = require("node:os");',
  ].join("\n");
  assert.deepEqual(importsOf(source).sort(), [
    "./input.ts",
    "./side-effect.ts",
    "node:child_process",
    "node:fs/promises",
    "node:os",
  ]);
});

test("every suppression form is found, with its line number", () => {
  const source = [
    "const fine = 1;",
    "// @ts-expect-error probe",
    "// biome-ignore lint/suspicious/noExplicitAny: probe",
    "/* eslint-disable no-console */",
    "/* c8 ignore next */",
    'test.skip("probe", () => {});',
    'test("probe", { only: true }, () => {});',
  ].join("\n");
  const found = findSuppressions(source);
  assert.deepEqual(
    found.map((hit) => hit.line),
    [2, 3, 4, 5, 6, 7],
  );
  assert.equal(found[0].reason, "TypeScript error suppressed");
  assert.equal(found[5].reason, "test skipped, focused or marked todo");
});

test("ordinary code is not mistaken for a suppression", () => {
  const source = ["const skip = false;", "items.filter((item) => item.only);"].join("\n");
  assert.deepEqual(findSuppressions(source), []);
});

test("every Stryker disable form is found", () => {
  const source = [
    "// Stryker disable all",
    "// Stryker disable next-line all",
    "// Stryker disable EqualityOperator: reason",
  ].join("\n");
  const found = findSuppressions(source);
  assert.deepEqual(
    found.map((hit) => hit.line),
    [1, 2, 3],
  );
  assert.deepEqual(
    found.map((hit) => hit.reason),
    ["mutation testing suppressed", "mutation testing suppressed", "mutation testing suppressed"],
  );
});

test("mentioning Stryker without disabling it is not a suppression", () => {
  const source = ["// uses Stryker for mutation testing", "// Stryker restore"].join("\n");
  assert.deepEqual(findSuppressions(source), []);
});

test("files without source functions have no CRAP scores", () => {
  const emptyReport = report({ functions: [{ name: "(empty-report)", loc: wholeFile }] });
  assert.deepEqual(crapScores(emptyReport, "const value = 1;", "empty.ts"), []);
});

test("c8 class initializer wrappers count decisions from source fields", () => {
  const scores = crapScores(
    report({
      functions: [
        {
          name: "<static_initializer>",
          loc: { start: { line: 2, column: 2 }, end: { line: 5, column: 32 } },
        },
        {
          name: "<instance_members_initializer>",
          loc: { start: { line: 6, column: 2 }, end: { line: 6, column: 27 } },
        },
      ],
    }),
    `class Example {
  static {
    if (true) {}
  }
  static value = true ? 1 : 2;
  instance = false && 1;
}`,
    "example.ts",
  );
  assert.deepEqual(
    scores.map((score) => score.complexity),
    [3, 2],
  );
});

test("complexity stays fixed when c8 reports more branch paths for the same source", () => {
  const source = "function f(value) { return value ? 1 : 0; }";
  const functions = [{ name: "f", loc: wholeFile }];
  const fewPaths = crapScores(
    report({ functions, statements: [{ line: 1, hits: 1 }], branches: [] }),
    source,
  )[0];
  const morePaths = crapScores(
    report({
      functions,
      statements: [{ line: 1, hits: 1 }],
      branches: [
        { line: 1, column: 20 },
        { line: 1, column: 20 },
        { line: 1, column: 20 },
        { line: 1, column: 20 },
      ],
    }),
    source,
  )[0];

  assert.equal(fewPaths.complexity, 2);
  assert.equal(morePaths.complexity, 2);
});

test("generator methods match c8 at the asterisk start", () => {
  const source = "const values = { *each() { if (true) return; } };";
  const [score] = crapScores(
    report({
      functions: [
        {
          name: "each",
          loc: { start: { line: 1, column: 17 }, end: { line: 1, column: 46 } },
        },
      ],
    }),
    source,
  );
  assert.equal(score.complexity, 2);
});

test("complexity counts every supported decision kind from source", () => {
  const source = `function everyDecision(value, list, object) {
  if (value) value = value ? value : 0;
  switch (value) { case 1: value++; break; default: break; }
  for (let i = 0; i < 1; i++) {}
  for (const item of list) {}
  for (const key in object) {}
  while (false) {}
  do {} while (false);
  try {} catch {}
  value && (value = 1);
  value || (value = 2);
  value ?? (value = 3);
  value &&= 1;
  value ||= 2;
  value ??= 3;
}`;
  const [score] = crapScores(
    report({ functions: [{ name: "everyDecision", loc: wholeFile }], statements: [] }),
    source,
  );

  assert.equal(score.complexity, 16);
});

test("a fully covered function scores its source complexity", () => {
  const [score] = crapScores(
    report({
      functions: [{ name: "f", loc: wholeFile }],
      statements: [{ line: 1, hits: 1 }],
      branches: [{ line: 1, column: 10 }],
    }),
    "function f() { return 1; }",
  );
  assert.equal(score.coverage, 1);
  assert.equal(score.crap, 1);
});

test("an uncovered branchy function scores far worse than a covered one", () => {
  const source = "function f(a, b, c, d) { if (a) {} if (b) {} if (c) {} if (d) {} }";
  const branches = [3, 5, 7, 9].map((line) => ({ line, column: 10 }));
  const functions = [{ name: "f", loc: wholeFile }];
  const covered = crapScores(
    report({ functions, statements: [{ line: 1, hits: 1 }], branches }),
    source,
  )[0];
  const bare = crapScores(
    report({ functions, statements: [{ line: 1, hits: 0 }], branches }),
    source,
  )[0];
  assert.equal(covered.crap, 5);
  assert.equal(bare.crap, 30);
});

test("quiet mode keeps what failed and drops what passed", () => {
  const output = [
    "  CORE     statements 100.0%, branches 100.0%, functions 100.0%, lines 100.0%",
    "  BOUNDARY statements 100.0%, branches 100.0%, functions 100.0%, lines 100.0%",
    "  CRAP     worst 9.0 (src/adapters/input.ts:21 classifyInput), bar 10",
    "",
    "CRAP above bar: src/adapters/input.ts:21 classifyInput scores 12.0",
    "coverage below bar: CORE branches 80.0% < 85%",
  ].join("\n");
  assert.deepEqual(quietDiagnostics(output).split("\n"), [
    "CRAP above bar: src/adapters/input.ts:21 classifyInput scores 12.0",
    "coverage below bar: CORE branches 80.0% < 85%",
  ]);
});

test("quiet mode drops a check's own success line", () => {
  assert.equal(quietDiagnostics("suppressions: none under src/ (6 files)"), "");
  assert.equal(quietDiagnostics("  tightened: crap.max 10 -> 8"), "");
});

test("a nested callback is counted apart from its parent", () => {
  const source = `function outer() {
  if (true) {}
  return [1].map(
    (value) => {
      if (value) return 1;
      return 0;
    },
  );
}`;
  const scores = crapScores(
    report({
      functions: [
        { name: "outer", loc: wholeFile },
        { name: "callback", loc: { start: { line: 4, column: 4 }, end: { line: 7, column: 5 } } },
      ],
      statements: [{ line: 2, hits: 1 }],
      branches: [
        { line: 3, column: 10 },
        { line: 5, column: 8 },
      ],
    }),
    source,
  );
  const byName = Object.fromEntries(scores.map((score) => [score.name, score]));
  assert.equal(byName.outer.complexity, 2);
  assert.equal(byName.callback.complexity, 2);
});

test("mutation covers the changed CORE lines, and all of an untracked CORE file", () => {
  const diff = [
    "diff --git a/src/application/load-workflow.ts b/src/application/load-workflow.ts",
    "--- a/src/application/load-workflow.ts",
    "+++ b/src/application/load-workflow.ts",
    "@@ -10,3 +10,4 @@ export function loadWorkflow() {",
    "@@ -40 +41 @@ function one() {",
    "@@ -60,5 +61,0 @@ function gone() {",
    "--- a/src/adapters/loop-command.ts",
    "+++ b/src/adapters/loop-command.ts",
    "@@ -1,2 +1,2 @@",
    "--- a/src/application/removed.ts",
    "+++ /dev/null",
    "@@ -1,9 +0,0 @@",
  ];
  const untracked = ["src/application/next-loop-action.ts", "src/adapters/loop-run.ts", ""];
  assert.deepEqual(changedCore(diff, untracked), [
    "src/application/next-loop-action.ts",
    "src/application/load-workflow.ts:10-13",
    "src/application/load-workflow.ts:41-41",
  ]);
});
