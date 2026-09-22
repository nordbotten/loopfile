/**
 * Fails when a suppression appears anywhere under `src/` (ADR 0009).
 *
 * A suppression comment turns off the very measurement the other checks rest
 * on, and a skipped test hides the behaviour a bar claims is covered. So this
 * check has no exception list, no allowlist and no environment escape. If one
 * is ever genuinely needed, change this file on purpose, with a human reading
 * the diff.
 *
 * Run directly to check the working tree.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, sourceFiles } from "./quality-zones.mjs";

/** What is never allowed under `src/`, and what to say about each one. */
const SUPPRESSIONS = [
  [/@ts-(?:ignore|expect-error|nocheck)\b/, "TypeScript error suppressed"],
  [/biome-ignore\b/, "Biome rule suppressed"],
  [/eslint-disable(?:-next-line|-line)?\b/, "ESLint rule suppressed"],
  [/\b(?:istanbul|c8|v8) ignore\b/, "coverage suppressed"],
  [/\.(?:skip|only|todo)\s*\(/, "test skipped, focused or marked todo"],
  [/\b(?:skip|only|todo)\s*:\s*true\b/, "test skipped, focused or marked todo"],
];

/** Every suppression in one file's text, with its line number. */
export function findSuppressions(source) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    for (const [pattern, reason] of SUPPRESSIONS) {
      const match = pattern.exec(line);
      if (match) found.push({ line: index + 1, text: match[0], reason });
    }
  });
  return found;
}

/** Checks every tracked source file. Returns the exit code. */
export function main(write) {
  const files = sourceFiles();
  const found = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const hit of findSuppressions(source)) found.push({ file, ...hit });
  }

  if (found.length > 0) {
    write("Suppressions under src/:\n");
    for (const { file, line, text, reason } of found) {
      write(`  ${file}:${line}  ${text}  (${reason})\n`);
    }
    write(
      "\nThere is no allowlist. Fix the code the suppression hides, or change\n" +
        "quality/quality-suppressions.mjs on purpose and say why in the diff.\n",
    );
    return 1;
  }

  write(`suppressions: none under src/ (${files.length} files)\n`);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main((text) => process.stdout.write(text));
}
