/** `loopfile result <runid> [--json]`: read a run without its owner (#226, #228). */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { valueSources } from "../application/prompt-fill.ts";
import {
  buildResultView,
  parseResultCommandArgs,
  type ResultValue,
  type ResultValues,
  type ResultView,
  renderResultView,
} from "../application/result-view.ts";
import { parseStatusProjection } from "../application/status.ts";
import type { RunEvent } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import { appendedDataFile, dataFile } from "./data-store.ts";
import { loadDirectory } from "./directory-loader.ts";
import { ownerLogHelp } from "./owner-log.ts";
import { loopfileHome, pathExists, runPaths } from "./run-directory.ts";
import { eventLogFailure, readEventLog } from "./run-discovery.ts";

const HELP = `Usage: loopfile result <runid> [--json]

Read the facts recorded for a run. Exit 0 for a completed run, 1 for a failed
or cancelled run, and 2 for a live, unknown or unreadable run.
`;

type Out = (text: string) => void;
type Err = (text: string) => void;

/** Runs the operator form of `result`. */
export async function resultCommand(
  argv: readonly string[],
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }

  const args = parseResultCommandArgs(argv);
  if (!args.ok) {
    return fail(err, { summary: args.message, code: "bad_argument", help: HELP.trim() });
  }

  const result = await readResult(args.runId, env);
  if ("code" in result) return fail(err, result);

  writeResult(out, result, args.json);
  if (result.state === "running") return 2;
  if (result.endReason === "internal_error") {
    err(
      renderOperatorFailure(
        {
          summary: `run ${result.runId} failed: internal_error`,
          code: "operation_failed",
          help: await ownerLogHelp(
            runPaths(loopfileHome(env as NodeJS.ProcessEnv), args.runId).ownerLog,
          ),
        },
        1,
      ).stderr,
    );
  }
  return result.state === "completed" ? 0 : 1;
}

type ResultRead = ResultView | OperatorFailure;

async function readResult(
  runId: string,
  env: Record<string, string | undefined>,
): Promise<ResultRead> {
  const paths = runPaths(loopfileHome(env as NodeJS.ProcessEnv), runId);
  try {
    if (!(await pathExists(paths.root))) {
      return {
        summary: `unknown run: ${runId}`,
        code: "no_such_run",
        help: "Use `loopfile list` to find a valid run ID.",
      };
    }
  } catch (error) {
    return {
      summary: `could not read run ${runId}${errorMessage(error)}`,
      code: "log_unreadable",
      help: "Check the run folder and its contents are readable.",
    };
  }

  let events: Awaited<ReturnType<typeof readEventLog>>;
  try {
    events = await readEventLog(paths.events, runId);
  } catch (error) {
    return eventLogFailure(error, runId);
  }

  try {
    const status = parseStatusProjection(JSON.parse(await readFile(paths.status, "utf8")));
    const values = await readDeclaredValues(paths, events);
    return buildResultView(events, status.loopfileName, values, status.metrics);
  } catch (error) {
    return {
      summary: `could not read result for run ${runId}${errorMessage(error)}`,
      code: "log_unreadable",
      help: "Check the run folder, its status.json and its Materialized Loopfile.",
    };
  }
}

const INLINE_LIMIT = 64 * 1024;

async function readDeclaredValues(
  paths: ReturnType<typeof runPaths>,
  events: readonly RunEvent[],
): Promise<ResultValues> {
  if (!(await pathExists(paths.loopfile))) return { inputs: {}, outputs: {} };
  const loaded = await loadDirectory(paths.loopfile);
  if (loaded.status !== "loaded") throw new Error(`the Materialized Loopfile did not load`);
  const inputs = Object.fromEntries(
    await Promise.all(
      Object.keys(loaded.workflow.inputs).map(async (name) => [
        name,
        describeValue(await readFile(join(paths.inputs, name)), join(paths.inputs, name)),
      ]),
    ),
  );
  const outputs = Object.fromEntries(
    await Promise.all(
      declaredOutputKeys(loaded.workflow).map(async (key) => [
        key,
        await outputValue(paths, events, key),
      ]),
    ),
  );
  return { inputs, outputs };
}

function declaredOutputKeys(workflow: Workflow): readonly string[] {
  return workflow.steps.flatMap((step) =>
    Object.keys(step.outputs).map((name) => `${step.id}.${name}`),
  );
}

async function outputValue(
  paths: ReturnType<typeof runPaths>,
  events: readonly RunEvent[],
  key: string,
): Promise<ResultValue> {
  const sources = valueSources(events, key);
  if (sources.length === 0) return { value: null, size: 0, truncated: false, path: null };

  const latest = events.findLast(
    (event): event is Extract<RunEvent, { type: "data.put" }> =>
      event.type === "data.put" && event.key === key,
  );
  if (latest?.appended === true) {
    const path = appendedDataFile(paths.attempts, key);
    try {
      return describeValue(await readFile(path), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Runs made before the aggregate was added still have every append in its own file.
      const content = Buffer.from(
        (await readSources(paths, key, sources)).map((part) => part.toString("utf8")).join("\n"),
      );
      await mkdir(join(paths.root, "result-values"), { recursive: true });
      await writeFile(path, content);
      return describeValue(content, path);
    }
  }

  const source = sources[0];
  if (source === undefined) throw new Error(`no value for ${key}`);
  const path = sourcePath(paths, key, source);
  return describeValue(await readFile(path), path);
}

async function readSources(
  paths: ReturnType<typeof runPaths>,
  key: string,
  sources: ReturnType<typeof valueSources>,
): Promise<readonly Buffer[]> {
  return await Promise.all(sources.map((source) => readFile(sourcePath(paths, key, source))));
}

function sourcePath(
  paths: ReturnType<typeof runPaths>,
  key: string,
  source: ReturnType<typeof valueSources>[number],
): string {
  return source.kind === "input"
    ? join(paths.inputs, source.name)
    : dataFile(paths.attempts, source.attemptId, key, source.writeIndex);
}

function describeValue(content: Buffer, path: string): ResultValue {
  const truncated = content.byteLength > INLINE_LIMIT;
  const inline = truncated ? truncateUtf8(content, INLINE_LIMIT) : content;
  return {
    value: inline.toString("utf8"),
    size: content.byteLength,
    truncated,
    path,
  };
}

function truncateUtf8(bytes: Buffer, maxBytes: number): Buffer {
  let end = maxBytes;
  while (end > 0 && (bytes.at(end) ?? 0) >> 6 === 0b10) end -= 1;
  return bytes.subarray(0, end);
}

function writeResult(out: Out, result: ResultView, json: boolean): void {
  out(json ? `${JSON.stringify(result)}\n` : renderResultView(result));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? `: ${error.message}` : "";
}

function fail(err: Err, failure: OperatorFailure): 2 {
  err(renderOperatorFailure(failure).stderr);
  return 2;
}
