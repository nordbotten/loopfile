/**
 * `loopfile list [--json]`: one row per run under `LOOPFILE_HOME`, newest and
 * most active first (#52).
 *
 * A read-only view built entirely from `discoverRuns` (`run-discovery.ts`):
 * this module only parses its own arguments, picks the human or `--json`
 * rendering, and decides whether ANSI is safe to print. It never touches a
 * run file itself.
 */

import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { buildRunList, NO_RUNS_MESSAGE, renderRunList } from "../application/run-list.ts";
import { discoverRuns, eventLogFailure } from "./run-discovery.ts";

type Out = (text: string) => void;
type Err = (text: string) => void;

const USAGE = "Usage: loopfile list [--json]";
const HELP = `${USAGE}

List every run, newest and most active first. Use --json for one structured
answer on stdout. List describes runs and returns 0 for a readable result; a
Loopfile read failure returns 2.
`;

/** Runs `list`. Returns the process exit code. */
export async function listCommand(
  argv: readonly string[],
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
  isTTY: boolean = process.stdout.isTTY === true,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const args = parseListArgs(argv);
  if (!args.ok) {
    return fail(err, {
      summary: args.message,
      code: "bad_argument",
      help: "Use `loopfile list` or `loopfile list --json`.",
    });
  }

  let entries: Awaited<ReturnType<typeof discoverRuns>>;
  try {
    entries = await discoverRuns(env as NodeJS.ProcessEnv);
  } catch (error) {
    return fail(err, failureFrom(error));
  }

  if (args.json) {
    out(`${JSON.stringify(buildRunList(entries))}\n`);
    return 0;
  }

  if (entries.length === 0) {
    out(NO_RUNS_MESSAGE);
    return 0;
  }

  out(renderRunList(entries, isTTY));
  return 0;
}

interface ListArgs {
  readonly ok: true;
  readonly json: boolean;
}

interface ListFailure {
  readonly ok: false;
  readonly message: string;
}

function parseListArgs(argv: readonly string[]): ListArgs | ListFailure {
  let json = false;
  for (const token of argv.slice(1)) {
    if (token === "--json") json = true;
    else return { ok: false, message: `unknown argument: ${token}\n${USAGE}` };
  }
  return { ok: true, json };
}

function failureFrom(error: unknown): OperatorFailure {
  return eventLogFailure(error);
}

function fail(err: Err, failure: OperatorFailure): 2 {
  err(renderOperatorFailure(failure).stderr);
  return 2;
}
