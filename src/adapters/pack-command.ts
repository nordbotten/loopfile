/**
 * `loopfile pack <directory> [-o <path>] [--force]`: writes a packed `.loop`
 * from a source directory (#8, decided in #80).
 *
 * The directory is loaded like a run loads it, so an invalid or older manifest
 * stops the command before any file is written. Every file is packed except
 * `.git/`. Links are followed by the loader's own check: one that points outside
 * the directory is a load error, and the archive holds no link at all.
 */

import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { create } from "tar";
import {
  type OperatorErrorCode,
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { DirectoryLoadError, loadDirectory, MANIFEST_NAME } from "./directory-loader.ts";
import { pathExists } from "./run-directory.ts";

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

const USAGE = "Usage: loopfile pack <directory> [-o <path>] [--force]";
const HELP = `${USAGE}

Write a packed .loop from a source directory. Use --force to replace an
existing output archive; -o chooses the output path. Exit 0 means the archive
was written, 1 means the source or operation failed, and 2 means the call was
invalid.
`;

/** Runs `pack`. Returns the process exit code. */
export async function packCommand(argv: readonly string[], out: Out, err: Out): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  return await packCommandWork(argv, err);
}

async function packCommandWork(argv: readonly string[], err: Out): Promise<number> {
  let parsed: ReturnType<typeof parsePackArgs>;
  try {
    parsed = parsePackArgs(argv);
  } catch (error) {
    return fail(err, (error as Error).message, "bad_argument", 2, USAGE);
  }
  const { directory, output, force } = parsed;
  if (directory === undefined) {
    return fail(err, "pack takes one source directory", "bad_argument", 2, USAGE);
  }
  try {
    if (!(await isDirectory(directory))) {
      return fail(err, `${directory} is not a source directory`, "bad_argument", 2, USAGE);
    }
    const problem = await loadProblem(directory);
    if (problem !== undefined) {
      return fail(err, problem, "invalid_manifest", 1, "Fix the manifest before packing.");
    }
    const target = resolve(output ?? `${basename(resolve(directory))}.loop`);
    if (!force && (await pathExists(target))) {
      return fail(err, `${target} already exists`, "bad_argument", 2, "Use --force to replace it.");
    }
    await writeArchive(resolve(directory), target);
    err(renderOperatorConfirmation({ packed: target }));
    return 0;
  } catch (error) {
    return fail(
      err,
      `cannot pack ${directory}: ${(error as Error).message}`,
      "operation_failed",
      1,
    );
  }
}

function parsePackArgs(argv: readonly string[]): {
  directory: string | undefined;
  output: string | undefined;
  force: boolean;
} {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: { output: { type: "string", short: "o" }, force: { type: "boolean" } },
    allowPositionals: true,
  });
  return {
    directory: positionals.length === 1 ? positionals[0] : undefined,
    output: values.output,
    force: values.force === true,
  };
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

/** Why the directory cannot be packed, or nothing when it loads. */
async function loadProblem(directory: string): Promise<string | undefined> {
  let result: Awaited<ReturnType<typeof loadDirectory>>;
  try {
    result = await loadDirectory(directory);
  } catch (error) {
    if (error instanceof DirectoryLoadError) return error.message;
    throw error;
  }
  if (result.status === "older") {
    return `${directory} uses format version ${result.formatVersion}, which is older than this loopfile reads: upgrade it before packing`;
  }
  if (result.status === "invalid") {
    const lines = result.errors.map(
      (e) => `  ${e.path}${e.line === undefined ? "" : ` (line ${e.line})`}: ${e.message}`,
    );
    return `${join(directory, MANIFEST_NAME)} is not valid:\n${lines.join("\n")}`;
  }
  return undefined;
}

/**
 * Every file under the directory, as `/`-separated relative names. Folders are
 * walked, never listed, so the archive holds no folder entry. `.git/` is left out.
 */
async function fileNames(root: string, folder = ""): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(join(root, folder))) {
    const relative = folder === "" ? name : `${folder}/${name}`;
    if (relative === ".git") continue;
    if ((await stat(join(root, relative))).isDirectory()) {
      found.push(...(await fileNames(root, relative)));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/** Byte-wise order, with `manifest.yaml` first. */
function archiveOrder(names: string[]): string[] {
  const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  return [
    ...names.filter((name) => name === MANIFEST_NAME),
    ...names.filter((name) => name !== MANIFEST_NAME).sort(byBytes),
  ];
}

/**
 * Writes to a temporary file beside the target, then renames it into place. The
 * tar bytes depend only on the names and contents: sorted names, mtime 0, no
 * owner, and a mode of `0644` or `0755` (#9).
 */
export async function writeArchive(directory: string, target: string): Promise<void> {
  const names = archiveOrder(await fileNames(directory));
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    await create(
      {
        file: temporary,
        cwd: directory,
        gzip: true,
        follow: true,
        portable: true,
        mtime: new Date(0),
        onWriteEntry: (entry) => {
          if (entry.stat === undefined) return;
          entry.stat.mode = (entry.stat.mode & 0o100) === 0 ? 0o644 : 0o755;
        },
        filter: (path) => ![target, temporary].includes(resolve(directory, path)),
      },
      names,
    );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
