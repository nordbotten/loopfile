/**
 * Loads a Loopfile from a source directory (#04) a thin `.loop` (#05) or a
 * packed `.loop` (#07) (ADR 0002, ADR 0008).
 *
 * It runs in two places. The CLI calls `loadDirectory` on the source before
 * launch, so errors show before a run owner starts and nothing is written. The
 * run owner calls `materializeDirectory` to copy the source into the run's
 * `loopfile/` folder, then `loadDirectory` on the copy. Resume does the same
 * load from the copy, so a later edit of the source never changes a run.
 *
 * The copy follows symbolic links, so it holds every file of the source. A link
 * that points outside the directory is a load error, the same rule as for a
 * packed `.loop` (#07).
 */

import { readFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { extract, list } from "tar";
import { LineCounter, parseDocument } from "yaml";
import { type LoadResult, type LoopfileRoot, loadWorkflow } from "../application/load-workflow.ts";
import type { InputKind } from "./input.ts";
import { pathExists } from "./run-directory.ts";

/** The manifest's name at the root of a source directory. */
export const MANIFEST_NAME = "manifest.yaml";

/** Thrown when a directory cannot be loaded at all. The message names the path. */
export class DirectoryLoadError extends Error {}

/**
 * Reads, parses and validates the Loopfile in `directory`. Validation errors
 * come back in the result, with lines. Anything that stops validation from
 * running (no manifest, bad YAML, a link out of the directory) is thrown.
 */
export async function loadDirectory(directory: string): Promise<LoadResult> {
  const manifestPath = join(directory, MANIFEST_NAME);
  const text = await readManifest(directory, manifestPath);
  await checkLinks(directory);

  return loadManifest(text, manifestPath, folderRoot(directory));
}

/** The Loopfile root of a materialized folder. */
export function folderRoot(directory: string): LoopfileRoot {
  return { readText: (path) => readOptional(join(directory, path)) };
}

/**
 * Reads, parses and validates a thin `.loop`, which is the manifest itself. It
 * has no Loopfile root, so `promptFile` is a validation error. The CLI calls
 * this before launch, like `loadDirectory` (#05).
 */
export async function loadThin(file: string): Promise<LoadResult> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new DirectoryLoadError(`cannot read ${file} (${error.code})`, { cause: error });
  });
  return loadThinText(text, file);
}

/** Loads manifest text with no assets, as a thin `.loop` or stdin manifest. */
export function loadThinText(text: string, label: string): LoadResult {
  return loadManifest(text, label, null);
}

/**
 * Writes a thin `.loop` as `manifest.yaml` in `destination`, which must not
 * exist yet. The run owner then loads that copy with `loadDirectory`, so a later
 * edit of the source file never changes a run.
 */
export async function materializeThin(file: string, destination: string): Promise<void> {
  if (await pathExists(destination)) {
    throw new DirectoryLoadError(`copy destination already exists: ${destination}`);
  }
  try {
    const text = await readFile(file, "utf8");
    await materializeThinText(text, destination);
  } catch (error) {
    if (error instanceof DirectoryLoadError) throw error;
    throw new DirectoryLoadError(
      `cannot copy ${file} to ${destination} (${(error as NodeJS.ErrnoException).code})`,
      { cause: error },
    );
  }
}

/** Writes stdin manifest text as the run's materialized thin Loopfile. */
export async function materializeThinText(text: string, destination: string): Promise<void> {
  if (await pathExists(destination)) {
    throw new DirectoryLoadError(`copy destination already exists: ${destination}`);
  }
  try {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, MANIFEST_NAME), text, { flag: "wx" });
  } catch (error) {
    throw new DirectoryLoadError(
      `cannot write stdin manifest to ${destination} (${(error as NodeJS.ErrnoException).code})`,
      { cause: error },
    );
  }
}

/** A packed `.loop` may not hold more than this many bytes once extracted. */
export const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024;

/**
 * Validates a packed `.loop` before launch. The archive is checked, extracted to
 * a temporary folder, loaded like a directory, and the folder is removed. Nothing
 * is written to a run folder (ADR 0008).
 */
export async function loadPacked(file: string): Promise<LoadResult> {
  const temporary = await mkdtemp(join(tmpdir(), "loopfile-packed-"));
  try {
    await extractPacked(file, temporary);
    return await loadDirectory(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Loads a classified source through the same loader used by launch and check. */
export function loadInput(source: string, kind: InputKind): Promise<LoadResult> {
  if (kind === "directory") return loadDirectory(source);
  return kind === "thin" ? loadThin(source) : loadPacked(source);
}

/**
 * Extracts a packed `.loop` into `destination`, which must not exist yet. The run
 * owner then loads that copy with `loadDirectory`. Extraction is strict: any
 * unsafe entry fails the whole load and nothing is skipped silently.
 */
export async function materializePacked(file: string, destination: string): Promise<void> {
  if (await pathExists(destination)) {
    throw new DirectoryLoadError(`copy destination already exists: ${destination}`);
  }
  await mkdir(destination, { recursive: true });
  await extractPacked(file, destination);
}

async function extractPacked(file: string, destination: string): Promise<void> {
  try {
    await checkArchive(file);
    await extract({ file, cwd: destination, strict: true, preservePaths: false });
  } catch (error) {
    if (error instanceof DirectoryLoadError) throw error;
    throw new DirectoryLoadError(`cannot read ${file}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** Reads every header and throws on the first entry that may not be extracted. */
async function checkArchive(file: string): Promise<void> {
  let hasManifest = false;
  let total = 0;
  let problem: string | undefined;
  await list({
    file,
    strict: true,
    onReadEntry: (entry) => {
      problem ??= entryProblem(entry.path, entry.type);
      hasManifest ||= entry.path === MANIFEST_NAME && entry.type === "File";
      total += entry.type === "File" ? entry.size : 0;
      problem ??= total > MAX_EXTRACTED_BYTES ? "more than 100 MB when extracted" : undefined;
    },
  });
  if (problem !== undefined)
    throw new DirectoryLoadError(`${file} is not safe to load: ${problem}`);
  if (!hasManifest) throw new DirectoryLoadError(`no ${MANIFEST_NAME} at the root of ${file}`);
}

function entryProblem(path: string, type: string): string | undefined {
  if (type !== "File" && type !== "Directory") return `${type} entry ${path} is not allowed`;
  if (isAbsolute(path) || path.includes("\\")) return `entry ${path} is not a relative path`;
  if (path.split("/").includes("..")) return `entry ${path} leaves the root`;
  return undefined;
}

/** Parses and validates manifest text against a Loopfile root (or none, for a thin `.loop`). */
export function loadManifest(text: string, label: string, root: LoopfileRoot | null): LoadResult {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines });
  const syntax = document.errors[0];
  if (syntax !== undefined) {
    throw new DirectoryLoadError(`${label} is not valid YAML: ${syntax.message}`);
  }
  return loadWorkflow(document.toJS(), {
    root,
    locate: (path) => {
      const range = document.getIn(pathParts(path), true);
      const offset = isRanged(range) ? range.range[0] : undefined;
      return offset === undefined ? undefined : lines.linePos(offset).line;
    },
  });
}

/** Copies the source into `destination`, which must not exist yet. */
export function materializeDirectory(source: string, destination: string): Promise<void> {
  return copyDirectory(source, destination, false);
}

/** Copies a remote source folder without its root Git metadata. */
export function materializeRemoteDirectory(source: string, destination: string): Promise<void> {
  return copyDirectory(source, destination, true);
}

async function copyDirectory(
  source: string,
  destination: string,
  omitRootGit: boolean,
): Promise<void> {
  await checkLinks(source, omitRootGit);
  if (await pathExists(destination)) {
    throw new DirectoryLoadError(`copy destination already exists: ${destination}`);
  }
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    filter: (path) => !omitRootGit || path !== join(source, ".git"),
  }).catch((error: NodeJS.ErrnoException) => {
    throw new DirectoryLoadError(`cannot copy ${source} to ${destination} (${error.code})`, {
      cause: error,
    });
  });
}

async function readManifest(directory: string, manifestPath: string): Promise<string> {
  try {
    return readFileSync(manifestPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR"
        ? `no ${MANIFEST_NAME} at the root of ${directory}`
        : `cannot read ${manifestPath} (${code})`;
    throw new DirectoryLoadError(reason, { cause: error });
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `steps[2].on.done` as `["steps", 2, "on", "done"]`. */
function pathParts(path: string): (string | number)[] {
  const parts: (string | number)[] = [];
  for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    parts.push(match[2] === undefined ? (match[1] as string) : Number(match[2]));
  }
  return parts;
}

function isRanged(node: unknown): node is { range: [number, number, number] } {
  return typeof node === "object" && node !== null && "range" in node && Array.isArray(node.range);
}

/** Throws on the first link under `directory` whose target is outside it. */
async function checkLinks(directory: string, omitRootGit = false): Promise<void> {
  const base = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    throw new DirectoryLoadError(`cannot read directory ${directory} (${error.code})`, {
      cause: error,
    });
  });
  await walk(directory, base, directory, omitRootGit);
}

async function walk(
  directory: string,
  base: string,
  root: string,
  omitRootGit: boolean,
): Promise<void> {
  for (const entry of await readdir(directory)) {
    if (omitRootGit && directory === root && entry === ".git") continue;
    const path = join(directory, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) await checkLink(path, base, root, omitRootGit);
    else if (info.isDirectory()) await walk(path, base, root, omitRootGit);
  }
}

async function checkLink(
  path: string,
  base: string,
  root: string,
  omitRootGit: boolean,
): Promise<void> {
  const target = await realpath(path).catch(() => undefined);
  const inside = target === undefined ? undefined : relative(base, target);
  if (inside === undefined || inside.startsWith("..") || isAbsolute(inside)) {
    throw new DirectoryLoadError(`symbolic link points outside the directory: ${path}`);
  }
  // A link to a directory is followed by the copy, so what is under it counts too.
  if ((await lstat(target as string)).isDirectory()) await walk(path, base, root, omitRootGit);
}
