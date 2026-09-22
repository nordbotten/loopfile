/**
 * `loopfile unpack <file.loop> [<destination>]`: extracts a `.loop` into an
 * editable source directory (#10, decided in #80).
 *
 * The input is told apart by content. A packed `.loop` goes through the same
 * strict extraction a run uses (#79); a thin `.loop` is copied as
 * `manifest.yaml`. Nothing is validated beyond what extraction needs, so an
 * invalid or older Loopfile can be unpacked and then fixed. Extraction goes to
 * a temporary folder beside the destination and is renamed into place only on
 * success, so a failure leaves nothing behind.
 */

import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type OperatorErrorCode,
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import { materializePacked, materializeThin } from "./directory-loader.ts";
import { classifyInput, InputError } from "./input.ts";

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

const USAGE = "Usage: loopfile unpack <file.loop> [<destination>]";
const HELP = `${USAGE}

Extract a thin or packed .loop into an editable source directory. The optional
destination must be new or empty. Exit 0 means extraction succeeded; invalid
input returns 2 and an extraction failure returns 1.
`;

/** Runs `unpack`. Returns the process exit code. */
export async function unpackCommand(argv: readonly string[], out: Out, err: Out): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  let positionals: string[];
  try {
    positionals = parseArgs({
      args: argv.slice(1),
      options: {},
      allowPositionals: true,
    }).positionals;
  } catch (error) {
    return fail(err, (error as Error).message, "bad_argument", 2, USAGE);
  }
  const [file, given] = positionals;
  if (file === undefined || positionals.length > 2) {
    return fail(
      err,
      "unpack takes one .loop file and an optional destination",
      "bad_argument",
      2,
      USAGE,
    );
  }
  const destination = resolve(given ?? basename(file).replace(/\.loop$/, ""));
  try {
    const kind = await classifyInput(file);
    if (kind === "directory") {
      return fail(err, `${file} is a directory`, "bad_argument", 2, USAGE);
    }
    if (!(await destinationIsFree(destination))) {
      return fail(
        err,
        `${destination} already exists`,
        "bad_argument",
        2,
        "Use a new or empty destination.",
      );
    }
    await extractInto(file, kind, destination);
    err(renderOperatorConfirmation({ unpacked: destination }));
    return 0;
  } catch (error) {
    return unpackFailure(err, file, error);
  }
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
  kind: "thin" | "packed",
  destination: string,
): Promise<void> {
  const holder = await mkdtemp(join(dirname(destination), `.${basename(destination)}.`));
  try {
    const staging = join(holder, "out");
    await (kind === "packed" ? materializePacked : materializeThin)(file, staging);
    await rename(staging, destination);
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
}
