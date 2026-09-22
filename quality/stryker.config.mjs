/**
 * Mutation testing over `CORE` only (ADR 0009).
 *
 * Coverage says a line ran. Mutation says the tests noticed. It changes the
 * code underneath them — flips a comparison, empties a block, rewrites a regex
 * — and any change no test complains about is a hole in the suite that a
 * coverage number cannot see.
 *
 * `CORE` alone, because that is where the workflow model, routing and the run
 * owner's decisions live. Mutating the CLI entry point only asks the suite to
 * kill mutants in process wiring nobody should be testing.
 *
 * `node --test` writes TAP, so this uses Stryker's tap runner. It runs each
 * test file on its own and records which files reach each mutant, so a mutant
 * runs only the test files that cover it. The command runner it replaced ran
 * the whole suite once per mutant, at about ten times the CPU. If it stops
 * being fast, scope the run rather than lower the bar.
 *
 * Only the `CORE` files this branch changed since it left `origin/main` are
 * mutated, committed or not. A branch that changes no `CORE` file mutates
 * nothing and passes. A test-only change is not checked against the code it
 * stops covering.
 *
 * The bar lives in `quality-ratchet.json`, like every other bar, and Stryker
 * enforces it directly by breaking the build below it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { filesInZone, REPO_ROOT } from "./quality-zones.mjs";

const bars = JSON.parse(readFileSync(new URL("quality-ratchet.json", import.meta.url), "utf8"));

/** Repository-relative files under `src/` that `git` lists for these arguments. */
function git(...args) {
  const output = execFileSync("git", [...args, "--", "src"], { cwd: REPO_ROOT, encoding: "utf8" });
  return output.split("\n");
}

/** Changed since the merge base with `origin/main`, plus files not yet tracked. */
const changed = new Set([
  ...git("diff", "--name-only", "--merge-base", "origin/main"),
  ...git("ls-files", "--others", "--exclude-standard"),
]);

/**
 * End-to-end tests that start processes, build git repositories or wait on
 * real timers. They reach most of `CORE`, so Stryker ran each one for most
 * mutants, and a mutant that made a run hang cost a full timeout. The last three
 * caused almost all of the timeouts and made the run over three times slower.
 * The unit tests must kill `CORE` mutants on their own. `gate` and `check` still
 * run these files.
 */
const SLOW_TESTS = new Set([
  "src/adapters/workflow-run.test.ts",
  "src/adapters/launch-command.test.ts",
  "src/adapters/monitor.test.ts",
  "src/adapters/cancel-command.test.ts",
  "src/adapters/implement-review-run.test.ts",
  "src/adapters/input-equivalence.test.ts",
  "src/adapters/feedback-loop.test.ts",
  "src/adapters/resume-command.test.ts",
]);

export default {
  testRunner: "tap",
  plugins: ["@stryker-mutator/tap-runner"],
  tap: { testFiles: filesInZone("TESTS").filter((file) => !SLOW_TESTS.has(file)) },
  mutate: filesInZone("CORE").filter((file) => changed.has(file)),
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress"],
  thresholds: { high: 90, low: bars.mutation.min, break: bars.mutation.min },
  tempDirName: ".stryker-tmp",
  // Agents keep worktrees here. Copying them into the sandbox would mutate
  // another branch's code, slowly.
  ignorePatterns: [".claude", "coverage", "dist", "reports"],
};
