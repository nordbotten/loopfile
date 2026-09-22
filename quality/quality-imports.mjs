/**
 * Keeps side effects out of `CORE` (ADR 0009).
 *
 * Loopfile's product is a deterministic runtime: the workflow model, routing
 * and the run owner's decisions have to be testable without a filesystem, a
 * process or a network. That holds only while `CORE` cannot reach them. A
 * `CORE` file that needs one of these is telling you it belongs under
 * `src/adapters/`.
 *
 * `BOUNDARY` and `EXEMPT` are unrestricted. They are where these details live.
 *
 * Run directly to check the working tree.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filesInZone, REPO_ROOT } from "./quality-zones.mjs";

/** Modules `CORE` may not reach, and what each one would let in. */
const FORBIDDEN = [
  [/^node:fs(\/.*)?$/, "the filesystem"],
  [/^node:child_process$/, "processes"],
  [/^node:os$/, "the host machine"],
  [/^node:(net|http|https|tls|dgram)$/, "the network"],
  [/^node:worker_threads$/, "threads"],
  // Harness adapters are built in (ADR 0004), so an SDK import is a zone slip.
  [/^(openai|@openai\/|@anthropic-ai\/)/, "a harness SDK"],
  [/^handlebars(?:\/lib(?:\/.*)?)?$/, "the Handlebars main entry"],
];

/** Every module specifier a file imports, statically or dynamically. */
export function importsOf(source) {
  const specifiers = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** The reason one specifier is forbidden in `CORE`, or `null` when it is fine. */
export function forbiddenReason(specifier) {
  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(specifier)) return reason;
  }
  return null;
}

/** Checks every `CORE` file. Returns the exit code. */
export function main(write) {
  const files = filesInZone("CORE");
  const found = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const specifier of importsOf(source)) {
      const reason = forbiddenReason(specifier);
      if (reason) found.push({ file, specifier, reason });
    }
  }

  if (found.length > 0) {
    write("CORE files reaching outside pure logic:\n");
    for (const { file, specifier, reason } of found) {
      write(`  ${file}  imports ${specifier}  (${reason})\n`);
    }
    write(
      "\nMove the side effect to a file under src/adapters/ and let the CORE\n" +
        "file take the result as an argument.\n",
    );
    return 1;
  }

  write(`imports: no CORE file reaches outside pure logic (${files.length} files)\n`);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main((text) => process.stdout.write(text));
}
