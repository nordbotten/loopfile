/**
 * The scripted fake harness adapter (#38, ADR 0004, ADR 0005). Test code only:
 * it is not in `DEFAULT_HARNESS_ADAPTERS` and no user can name it. This file
 * only exports, so a test that imports it does not run tests twice; its own
 * checks are in `fake-harness-check.test.ts`.
 *
 * `prepare` returns a `node` command. The runtime starts it through the
 * executor. The child runs the scripted actions and calls the real `loopfile`
 * CLI over `LOOPFILE_ENDPOINT`. The adapter never returns an outcome or data.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessActivity, HarnessAdapter, HarnessAdapters } from "../application/harness.ts";
import type { StepId } from "../domain/model.ts";

/** One thing a scripted call does. Paths are relative to the workspace. */
export type FakeAction =
  | { readonly do: "write"; readonly path: string; readonly content: string }
  | { readonly do: "activity"; readonly activity: HarnessActivity }
  | { readonly do: "savePrompt"; readonly path: string }
  | { readonly do: "dataGet"; readonly key: string; readonly to: string }
  | { readonly do: "dataPut"; readonly key: string; readonly content: string }
  | { readonly do: "result"; readonly outcome: string; readonly message?: string }
  | { readonly do: "exit"; readonly code: number }
  | { readonly do: "sleep"; readonly ms: number };

/**
 * Step ID to its calls, in order. Call n of a step runs `calls[n - 1]`.
 * The count is per step, across all attempts and all Ralph iterations.
 */
export type FakeScript = Readonly<Record<StepId, readonly (readonly FakeAction[])[]>>;

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** CommonJS, run with `node -e`. Arguments: the actions file and the CLI path. */
const FAKE_CHILD_SOURCE = `
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { dirname } = require("node:path");
const [file, cli] = process.argv.slice(1);
const prompt = readFileSync(0);
const actions = JSON.parse(readFileSync(file, "utf8"));
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const loopfile = (args, input) =>
  spawnSync(process.execPath, [cli, ...args], { input, stdio: ["pipe", "pipe", "inherit"] });
for (const a of actions) {
  if (a.do === "write") write(a.path, a.content);
  else if (a.do === "activity") process.stdout.write(JSON.stringify(a.activity) + "\\n");
  else if (a.do === "savePrompt") write(a.path, prompt);
  else if (a.do === "dataGet") {
    const got = loopfile(["data", "get", a.key]);
    if (got.status === 0) write(a.to, got.stdout);
  } else if (a.do === "dataPut") loopfile(["data", "put", a.key, "-"], a.content);
  else if (a.do === "result")
    loopfile(["result", a.outcome, ...(a.message === undefined ? [] : ["--message", a.message])]);
  else if (a.do === "exit") process.exit(a.code);
  else if (a.do === "sleep") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, a.ms);
}
`;

const ACTIVITY_KINDS = new Set(["tool", "progress", "metrics"]);

/** Any line that is not a `tool`, `progress` or `metrics` activity gives nothing. Never throws. */
function parseStdoutLine(line: string): readonly HarnessActivity[] {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return [];
    const { kind } = value as { kind?: unknown };
    return typeof kind === "string" && ACTIVITY_KINDS.has(kind) ? [value as HarnessActivity] : [];
  } catch {
    return [];
  }
}

export function fakeHarness(script: FakeScript): HarnessAdapter {
  const counts = new Map<StepId, number>();
  return {
    prepare(call) {
      const step = call.context.stepId;
      const number = (counts.get(step) ?? 0) + 1;
      counts.set(step, number);
      const actions = Object.hasOwn(script, step) ? script[step]?.[number - 1] : undefined;
      if (actions === undefined) {
        throw new Error(`fake harness: step ${step} has no scripted call ${number}`);
      }
      return {
        command: process.execPath,
        args: ["-e", FAKE_CHILD_SOURCE, join(call.wiringFolder, "fake-call.json"), CLI],
        stdin: call.prompt,
        wiringFiles: { "fake-call.json": JSON.stringify(actions) },
        parseStdoutLine,
      };
    },
  };
}

/** The same fake instance behind every harness name, so the count is shared. */
export function fakeHarnessAdapters(script: FakeScript): HarnessAdapters {
  const adapter = fakeHarness(script);
  return { claude: adapter, pi: adapter };
}
