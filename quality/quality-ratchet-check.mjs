/**
 * Bars may tighten. They may not loosen (ADR 0009).
 *
 * Every number in `quality-ratchet.json` is compared with the same number on
 * the base branch. Coverage floors and the mutation floor may only rise; the
 * CRAP ceiling may only fall. This is the check that makes the other bars mean
 * something: without it, the cheapest way past a failing gate is to edit the
 * bar, and that edit looks exactly like the work in a diff full of other
 * changes.
 *
 * On `main` there is no base to compare against, so the check reports and
 * passes. A bar can therefore only be loosened by a direct push to `main`,
 * which is the captain's to make.
 *
 * Run directly to check the working tree against origin/main, or pass a ref.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./quality-zones.mjs";

/** Where the bars live. The only file this check reads. */
const RATCHET = "quality/quality-ratchet.json";

/** Every bar as a flat path, and which direction is an improvement. */
function bars(ratchet) {
  const flat = new Map();
  for (const [zone, metrics] of Object.entries(ratchet.coverage)) {
    for (const [metric, value] of Object.entries(metrics)) {
      flat.set(`coverage.${zone}.${metric}`, { value, better: "higher" });
    }
  }
  flat.set("crap.max", { value: ratchet.crap.max, better: "lower" });
  flat.set("mutation.min", { value: ratchet.mutation.min, better: "higher" });
  return flat;
}

/** The ratchet file as it is on `ref`, or `null` when the ref is unreachable. */
function ratchetAt(ref) {
  try {
    const text = execFileSync("git", ["show", `${ref}:${RATCHET}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Compares the working bars with the base's. Returns the exit code. */
export function main(argv, write) {
  const { values } = parseArgs({ args: argv, options: { base: { type: "string" } } });
  const base = values.base ?? "origin/main";

  const current = JSON.parse(readFileSync(join(REPO_ROOT, RATCHET), "utf8"));
  const previous = ratchetAt(base);
  if (previous === null) {
    write(`ratchet: no ${RATCHET} on ${base}, nothing to compare\n`);
    return 0;
  }

  const currentBars = bars(current);
  const previousBars = bars(previous);
  const loosened = [];
  const tightened = [];

  for (const [path, { value, better }] of previousBars) {
    if (!currentBars.has(path)) {
      loosened.push(`${path} was ${value} and is now gone`);
      continue;
    }
    const now = currentBars.get(path).value;
    if (now === value) continue;
    const isBetter = better === "higher" ? now > value : now < value;
    (isBetter ? tightened : loosened).push(`${path} ${value} -> ${now}`);
  }

  for (const line of tightened) write(`  tightened: ${line}\n`);

  if (loosened.length > 0) {
    write(`\nBars loosened against ${base}:\n`);
    for (const line of loosened) write(`  ${line}\n`);
    write(
      "\nA bar is a floor, not a dial. Fix the code that failed rather than the\n" +
        "number that caught it. If the bar is genuinely wrong, change it on main.\n",
    );
    return 1;
  }

  write(`ratchet: no bar loosened against ${base}\n`);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2), (text) => process.stdout.write(text));
}
