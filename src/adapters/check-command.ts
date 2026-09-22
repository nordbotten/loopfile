/** `loopfile check <source> [--json]`: validate without starting a run. */

import { parseArgs } from "node:util";
import { checkAgainstDeclared, inputHelp, parseInputFlags } from "../application/launch-inputs.ts";
import type { LoadError, LoadResult } from "../application/load-workflow.ts";
import { renderOperatorFailureLines } from "../application/operator-error.ts";
import { loadInput, loadThinText } from "./directory-loader.ts";
import { classifyInput, InputError, type InputKind, readStdin } from "./input.ts";

type Out = (text: string) => void;

const USAGE = "Usage: loopfile check <source> [--json] [--input <name>=<value>]...";
const HELP = `${USAGE}

Validate a Loopfile and its launch inputs without starting a run. Use '-' as the
source to read a thin manifest from stdin. Use --json for
one structured array of manifest problems. Check does not inspect the run
environment, such as harness binaries.
`;

interface CheckArgs {
  readonly source: string | undefined;
  readonly inputs: readonly string[];
  readonly json: boolean;
}

/** Runs `check`. Returns 0 when launch would accept the source and inputs. */
export async function checkCommand(
  argv: readonly string[],
  out: Out,
  err: Out,
  readInput: () => Promise<Buffer> = readStdin,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }

  const args = parseCheckArgs(argv);
  if (args === undefined || args.source === undefined) {
    return fail(err, "check takes one source", 2, USAGE);
  }

  const source = await readSource(args.source, readInput);
  if (!source.ok) return fail(err, source.summary, source.exitCode, source.help, source.code);

  if (!reportManifest(source.result, args.json, out)) return 1;

  const inputs = checkInputs(
    args.inputs,
    source.result.workflow.inputs,
    source.result.workflow.inputDefaults,
  );
  if (!inputs.ok)
    return fail(err, inputs.messages, 2, inputHelp(source.result.workflow.inputDefaults));

  out(args.json ? "[]\n" : "Loopfile is valid.\n");
  return 0;
}

type SourceResult =
  | { readonly ok: true; readonly result: LoadResult }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly code: "bad_argument" | "operation_failed";
      readonly exitCode: 1 | 2;
      readonly help: string;
    };

async function readSource(source: string, readInput: () => Promise<Buffer>): Promise<SourceResult> {
  if (source === "-") {
    try {
      return { ok: true, result: loadThinText((await readInput()).toString("utf8"), source) };
    } catch (error) {
      return {
        ok: false,
        summary: `cannot read stdin: ${(error as Error).message}`,
        code: "operation_failed",
        exitCode: 1,
        help: USAGE,
      };
    }
  }

  let kind: InputKind;
  try {
    kind = await classifyInput(source);
  } catch (error) {
    const input = error instanceof InputError;
    return {
      ok: false,
      summary: (error as Error).message,
      code: input ? "bad_argument" : "operation_failed",
      exitCode: input ? 2 : 1,
      help: USAGE,
    };
  }

  try {
    return { ok: true, result: await loadInput(source, kind) };
  } catch (error) {
    return {
      ok: false,
      summary: (error as Error).message,
      code: "operation_failed",
      exitCode: 1,
      help: "Fix the source before checking.",
    };
  }
}

function parseCheckArgs(argv: readonly string[]): CheckArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        input: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (positionals.length > 1) return undefined;
    return {
      source: positionals[0],
      inputs: values.input ?? [],
      json: values.json === true,
    };
  } catch {
    return undefined;
  }
}

function reportManifest(
  result: LoadResult,
  json: boolean,
  out: Out,
): result is Extract<LoadResult, { readonly status: "loaded" }> {
  if (result.status === "loaded") return true;
  const errors: readonly LoadError[] =
    result.status === "invalid"
      ? result.errors
      : [{ path: "formatVersion", message: `formatVersion ${result.formatVersion} is outdated` }];
  out(`${json ? JSON.stringify(errors) : renderErrors(errors)}\n`);
  return false;
}

function checkInputs(
  flags: readonly string[],
  declared: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>> | undefined,
): ReturnType<typeof checkAgainstDeclared> {
  const given = parseInputFlags(flags);
  return given.ok ? checkAgainstDeclared(given.inputs, declared, defaults) : given;
}

function renderErrors(errors: readonly LoadError[]): string {
  return errors
    .map((error) => {
      const line = error.line === undefined ? "" : `line ${error.line}: `;
      return `${line}${error.path === "" ? "" : `${error.path}: `}${error.message}`;
    })
    .join("\n");
}

function fail(
  err: Out,
  summary: string | readonly string[],
  exitCode: 1 | 2,
  help: string,
  code: "bad_argument" | "operation_failed" = "bad_argument",
): number {
  const summaries = typeof summary === "string" ? [summary] : summary;
  err(renderOperatorFailureLines(summaries, code, help, exitCode).stderr);
  return exitCode;
}
