/** `loopfile unpack <file.loop|remote> [<destination>]` makes a local source directory. */

import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type OperatorErrorCode,
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { formatRemoteLine } from "../application/remote-view.ts";
import { parseSource, type RemoteSource, SourceParseError } from "../application/source.ts";
import {
  materializePacked,
  materializeRemoteDirectory,
  materializeThin,
} from "./directory-loader.ts";
import { classifyInput, InputError, sourceExists } from "./input.ts";
import {
  type FetchedRemote,
  fetchRemote,
  RemoteFetchError,
  remoteFetchOperatorFailure,
} from "./remote-fetch.ts";

type Out = (text: string) => void;

function fail(
  err: Out,
  summary: string,
  code: OperatorErrorCode,
  exitCode: 1 | 2,
  help = "Check the command arguments.",
): number {
  err(renderOperatorFailure({ summary, code, help }, exitCode).stderr);
  return exitCode;
}

const USAGE = "Usage: loopfile unpack <file.loop|remote> [<destination>]";
const HELP = `${USAGE}

Extract a thin or packed .loop, or copy a remote source directory, into a local
source directory. A remote copy has no link to its origin and needs no trust.
The optional destination must be new or empty. Exit 0 means unpack succeeded;
invalid input returns 2 and an extraction failure returns 1.
`;

/** Runs `unpack`. Returns the process exit code. */
export async function unpackCommand(
  argv: readonly string[],
  out: Out,
  err: Out,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  let values: { trust?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { trust: { type: "boolean" } },
      allowPositionals: true,
    }));
  } catch (error) {
    return fail(err, (error as Error).message, "bad_argument", 2, USAGE);
  }
  if (values.trust === true)
    return fail(err, "--trust is for launch only", "bad_argument", 2, USAGE);
  const [source, given] = positionals;
  if (source === undefined || positionals.length > 2) {
    return fail(
      err,
      "unpack takes one .loop file or remote source and an optional destination",
      "bad_argument",
      2,
      USAGE,
    );
  }

  let parsed: ReturnType<typeof parseSource>;
  try {
    parsed = parseSource(source, await sourceExists(source));
  } catch (error) {
    return fail(
      err,
      (error as Error).message,
      "bad_argument",
      2,
      error instanceof SourceParseError ? error.help : USAGE,
    );
  }
  if (parsed.kind === "local") return unpackLocal(source, given, err);
  return unpackRemote(source, given, parsed, env, err);
}

async function unpackLocal(source: string, given: string | undefined, err: Out): Promise<number> {
  const destination = resolve(given ?? basename(source).replace(/\.loop$/, ""));
  try {
    const kind = await classifyInput(source);
    if (kind === "directory")
      return fail(err, `${source} is a directory`, "bad_argument", 2, USAGE);
    if (!(await destinationIsFree(destination))) return destinationExists(err, destination);
    await extractInto(source, kind, destination);
    err(renderOperatorConfirmation({ unpacked: destination }));
    return 0;
  } catch (error) {
    return unpackFailure(err, source, error);
  }
}

async function unpackRemote(
  source: string,
  given: string | undefined,
  remote: RemoteSource,
  env: Record<string, string | undefined>,
  err: Out,
): Promise<number> {
  let fetched: FetchedRemote | undefined;
  try {
    fetched = await fetchRemote(remote, env);
    const name =
      fetched.remote.path
        ?.split("/")
        .at(-1)
        ?.replace(/\.loop$/, "") ??
      fetched.remote.repo.split("/").at(-1) ??
      fetched.remote.repo;
    const destination = resolve(given ?? name);
    const kind = await classifyInput(fetched.path);
    if (!(await destinationIsFree(destination))) return destinationExists(err, destination);
    await extractInto(fetched.path, kind, destination);
    err(
      renderOperatorConfirmation({ unpacked: destination }) +
        `${formatRemoteLine({ ...fetched.remote, sha: fetched.sha }, true)}\n`,
    );
    return 0;
  } catch (error) {
    if (fetched === undefined) return remoteFetchFailure(err, remote, error);
    return unpackFailure(err, source, error);
  } finally {
    await fetched?.cleanup().catch(() => undefined);
  }
}

function destinationExists(err: Out, destination: string): number {
  return fail(
    err,
    `${destination} already exists`,
    "bad_argument",
    2,
    "Use a new or empty destination.",
  );
}

function remoteFetchFailure(err: Out, remote: RemoteSource, error: unknown): number {
  const standardFailure = remoteFetchOperatorFailure(remote, error);
  if (standardFailure !== undefined) {
    err(standardFailure.stderr);
    return 2;
  }
  const message =
    remote.bareSource === undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : `no local path and no GitHub repo named ${remote.bareSource}`;
  const code = error instanceof RemoteFetchError ? error.code : "operation_failed";
  return fail(err, message, code, 2, USAGE);
}

function unpackFailure(err: Out, file: string, error: unknown): number {
  const inputError = error instanceof InputError;
  return fail(
    err,
    `cannot unpack ${file}: ${error instanceof Error ? error.message : String(error)}`,
    inputError ? "bad_argument" : "operation_failed",
    inputError ? 2 : 1,
  );
}

/** True when nothing is there, or an empty directory is. */
async function destinationIsFree(destination: string): Promise<boolean> {
  const info = await stat(destination).catch(() => undefined);
  if (info === undefined) return true;
  return info.isDirectory() && (await readdir(destination)).length === 0;
}

async function extractInto(
  file: string,
  kind: "directory" | "thin" | "packed",
  destination: string,
): Promise<void> {
  const holder = await mkdtemp(join(dirname(destination), `.${basename(destination)}.`));
  try {
    const staging = join(holder, "out");
    if (kind === "directory") await materializeRemoteDirectory(file, staging);
    else await (kind === "packed" ? materializePacked : materializeThin)(file, staging);
    await rename(staging, destination);
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
}
