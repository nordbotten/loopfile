/** `loopfile check <source> [--json]`: validate without starting a run. */

import { parseArgs } from "node:util";
import { checkDeclaredInputs, inputHelp, parseInputFlags } from "../application/launch-inputs.ts";
import type { LoadError, LoadResult } from "../application/load-workflow.ts";
import { renderOperatorFailureLines } from "../application/operator-error.ts";
import { formatRemoteLine } from "../application/remote-view.ts";
import { parseSource, type RemoteSource, SourceParseError } from "../application/source.ts";
import { loadInput, loadThinText } from "./directory-loader.ts";
import { classifyInput, InputError, type InputKind, readStdin, sourceExists } from "./input.ts";
import {
  type FetchedRemote,
  fetchRemote,
  RemoteFetchError,
  remoteFetchOperatorFailure,
} from "./remote-fetch.ts";

type Out = (text: string) => void;

const USAGE =
  "Usage: loopfile check <directory|file.loop|github:owner/repo[/path][@ref]|git+https://…|git+ssh://…|-> [--json] [--input <name>=<value>]...";
const HELP = `${USAGE}

Validate a local or remote Loopfile manifest and the names of any --input
flags given, without starting a run. Launch still requires each input without
a default. Remote Loopfiles are fetched but never checked against trust.yaml.
Use '-' to read a thin manifest from stdin, and --json for one structured
array of manifest problems. Check does not inspect the run environment, such
as harness binaries.
`;

interface CheckArgs {
  readonly source: string | undefined;
  readonly inputs: readonly string[];
  readonly json: boolean;
  readonly trust: boolean;
}

/** Runs `check`. Returns 0 when the manifest and given input names are valid. */
export async function checkCommand(
  argv: readonly string[],
  out: Out,
  err: Out,
  readInput: () => Promise<Buffer> = readStdin,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }

  const args = parseCheckArgs(argv);
  if (args?.trust === true) return fail(err, "--trust is for launch only", 2, USAGE);
  if (args === undefined || args.source === undefined) {
    return fail(err, "check takes one source", 2, USAGE);
  }

  const source = await readSource(args.source, readInput, env, args.json, out);
  if (!source.ok) return reportSourceFailure(source, err);

  if (!reportManifest(source.result, args.json, out)) return 1;

  const inputs = checkInputs(args.inputs, source.result.workflow.inputs);
  if (!inputs.ok)
    return fail(err, inputs.messages, 2, inputHelp(source.result.workflow.inputDefaults));

  out(args.json ? "[]\n" : "Loopfile is valid.\n");
  return 0;
}

function reportSourceFailure(
  source: Extract<SourceResult, { readonly ok: false }>,
  err: Out,
): number {
  if (source.stderr !== undefined) {
    err(source.stderr);
    return source.exitCode;
  }
  return fail(err, source.summary, source.exitCode, source.help, source.code);
}

type SourceResult =
  | { readonly ok: true; readonly result: LoadResult }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly code: "bad_argument" | "git_missing" | "fetch_failed" | "operation_failed";
      readonly exitCode: 1 | 2;
      readonly help: string;
      readonly stderr?: string;
    };

async function readSource(
  source: string,
  readInput: () => Promise<Buffer>,
  env: Record<string, string | undefined>,
  json: boolean,
  out: Out,
): Promise<SourceResult> {
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

  let parsed: ReturnType<typeof parseSource>;
  try {
    parsed = parseSource(source, await sourceExists(source));
  } catch (error) {
    return {
      ok: false,
      summary: (error as Error).message,
      code: "bad_argument",
      exitCode: 2,
      help: error instanceof SourceParseError ? error.help : USAGE,
    };
  }

  if (parsed.kind === "remote") {
    let fetched: FetchedRemote;
    try {
      fetched = await fetchRemote(parsed, env);
    } catch (error) {
      return remoteFailure(parsed, error);
    }
    try {
      if (!json) out(`${formatRemoteLine({ ...fetched.remote, sha: fetched.sha }, true)}\n`);
      return await readLocalSource(fetched.path);
    } finally {
      await fetched.cleanup().catch(() => undefined);
    }
  }
  return readLocalSource(parsed.source);
}

async function readLocalSource(source: string): Promise<SourceResult> {
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

function remoteFailure(remote: RemoteSource, error: unknown): SourceResult {
  const standardFailure = remoteFetchOperatorFailure(remote, error);
  if (standardFailure !== undefined) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      code: standardFailure.code,
      exitCode: 2,
      help: USAGE,
      stderr: standardFailure.stderr,
    };
  }
  return {
    ok: false,
    summary: error instanceof Error ? error.message : String(error),
    code: error instanceof RemoteFetchError ? error.code : "operation_failed",
    exitCode: 2,
    help: USAGE,
  };
}

function parseCheckArgs(argv: readonly string[]): CheckArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        input: { type: "string", multiple: true },
        json: { type: "boolean" },
        trust: { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (positionals.length > 1) return undefined;
    return {
      source: positionals[0],
      inputs: values.input ?? [],
      json: values.json === true,
      trust: values.trust === true,
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
): ReturnType<typeof checkDeclaredInputs> {
  const given = parseInputFlags(flags);
  return given.ok ? checkDeclaredInputs(given.inputs, declared) : given;
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
  code: "bad_argument" | "git_missing" | "fetch_failed" | "operation_failed" = "bad_argument",
): number {
  const summaries = typeof summary === "string" ? [summary] : summary;
  err(renderOperatorFailureLines(summaries, code, help, exitCode).stderr);
  return exitCode;
}
