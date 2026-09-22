/**
 * The quality stack's entry point. One list of checks, with a reporting mode
 * for each caller:
 *
 *   npm run quality     runs every check, prints every result, ALWAYS exits 0
 *   npm run gate        runs every check, exits 1 if any of them failed
 *   npm run gate:quiet  the same gate, with compact success and the failing
 *                       check's diagnostics stripped down to what failed
 *
 * Every mode runs every check rather than stopping at the first failure, so one
 * run tells you everything that is wrong. The loud modes keep each checker's
 * own output, so quiet reporting never becomes the only way to see it.
 *
 * Checks run as subprocesses. A checker that crashes should fail its own line,
 * not take the runner down with it.
 *
 * Mutation is not here. It runs the whole suite once per mutant, and the gate
 * is meant to be cheap enough to run constantly.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * @typedef {object} Check
 * @property {string} id       Short stable name, printed in the summary.
 * @property {string} label    One line saying what the check answers.
 * @property {string} bar      The applicable quality bar.
 * @property {string} command  Narrow command that confirms this one check.
 * @property {string[]} argv   Command and arguments, run without a shell.
 */

/** @type {Check[]} */
export const CHECKS = [
  {
    id: "zones",
    label: "Every source file under src/ is claimed by a zone",
    bar: "quality/quality-zones.mjs classifies every file the project owns under src/.",
    command: "npm run quality:zones",
    argv: ["npm", "run", "--silent", "quality:zones"],
  },
  {
    id: "suppressions",
    label: "No suppression comment or skipped test exists under src/",
    bar: "src/ contains no banned suppression marker and no skipped, focused or todo test.",
    command: "npm run quality:suppressions",
    argv: ["npm", "run", "--silent", "quality:suppressions"],
  },
  {
    id: "imports",
    label: "No CORE file reaches the filesystem, processes, the network or a harness",
    bar: "CORE imports nothing listed as forbidden in quality/quality-imports.mjs.",
    command: "npm run quality:imports",
    argv: ["npm", "run", "--silent", "quality:imports"],
  },
  {
    id: "coverage",
    label: "CORE and BOUNDARY meet their coverage bars, and no function is CRAP",
    bar: "Every coverage.* floor and the crap.max ceiling in quality/quality-ratchet.json hold.",
    command: "npm run quality:coverage",
    argv: ["npm", "run", "--silent", "quality:coverage"],
  },
];

/**
 * Runs one check.
 *
 * @param {Check} check
 * @param {boolean} quiet
 */
export function runCheck(check, quiet) {
  const run = spawnSync(check.argv[0], check.argv.slice(1), {
    encoding: "utf8",
    shell: false,
    ...(quiet ? { stdio: ["ignore", "pipe", "pipe"] } : { stdio: "inherit" }),
  });
  const output = quiet ? [run.stdout, run.stderr].filter(Boolean).join("").trim() : "";
  const error = run.error?.message ?? "";
  return { ...check, ok: run.status === 0, output, error };
}

/**
 * Lines that say something passed.
 *
 * A failing check still prints everything that went right alongside the one
 * thing that did not. In quiet mode those lines are noise between you and the
 * repair, so they are dropped.
 */
const QUIET_SUCCESS_LINES = [
  /^\s*(?:zones|suppressions|imports|coverage|ratchet):\s/,
  /^\s*(?:CORE|BOUNDARY)\s+statements\s/,
  /^\s*CRAP\s+worst\s/,
  /^\s*[✓✔]\s+/,
  /^\s*(?:ok|pass|tests|PASS)\b/i,
  /^\s*tightened:\s/,
];

/** @param {string} output */
export function quietDiagnostics(output) {
  return output
    .split("\n")
    .filter((line) => !QUIET_SUCCESS_LINES.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim();
}

/** @param {ReturnType<typeof runCheck>} result */
function printQuietResult(result, write) {
  write(`\n## ${result.label}\n`);
  write(result.ok ? "Passed\n" : "Failed\n");
  if (result.ok) return;

  write(`  Confirm: ${result.command}\n`);
  write(`  Bar: ${result.bar}\n`);
  const diagnostics = quietDiagnostics([result.output, result.error].filter(Boolean).join("\n"));
  if (diagnostics) {
    write("  Diagnostics:\n");
    for (const line of diagnostics.split("\n")) write(`    ${line}\n`);
  }
}

/** Runs every check in the requested mode. Returns the exit code. */
export function run(argv, write) {
  const gating = argv.includes("--gate");
  const quiet = argv.includes("--quiet");
  const mode = gating ? "gate" : "quality";

  if (!quiet) write(`\nQuality ${mode} — ${CHECKS.length} checks\n\n`);

  const results = CHECKS.map((check) => {
    if (!quiet) write(`── ${check.id}: ${check.label}\n`);
    const result = runCheck(check, quiet);
    if (!quiet) write(`   ${result.ok ? "PASS" : "FAIL"} ${result.id}\n\n`);
    return result;
  });
  const failed = results.filter((result) => !result.ok);

  if (quiet) {
    for (const result of results) printQuietResult(result, write);
  } else {
    write("Summary\n");
    for (const result of results) {
      write(`  ${result.ok ? "PASS" : "FAIL"}  ${result.id.padEnd(13)} ${result.label}\n`);
    }
    if (failed.length === 0) write("\nAll checks passed.\n");
    else if (gating) write(`\n${failed.length} check(s) failed. Gate is red.\n`);
    else write(`\n${failed.length} check(s) failed. Reporting only — run \`npm run gate\`.\n`);
  }

  return gating && failed.length > 0 ? 1 : 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = run(process.argv.slice(2), (text) => process.stdout.write(text));
}
