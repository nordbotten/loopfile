/**
 * Classifies a launch input path by content, not by name (#06).
 *
 * A packed `.loop` is a gzipped tar (#79), so its first two bytes are `1f 8b`.
 * Anything else that reads as text is the manifest itself, a thin `.loop`.
 * Extracting (#07) and parsing the manifest (#03) happen after this.
 */

import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

/** What a launch input path is. */
export type InputKind = "directory" | "thin" | "packed";

/** Bytes read to decide. Enough for the gzip magic and a good text sample. */
const SAMPLE_BYTES = 8192;

/** Thrown when a path is not a Loopfile input. The message names the path. */
export class InputError extends Error {}

/** Reads all of stdin into one buffer. */
export function readStdin(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

/** Asks one line on the terminal. `null` on EOF. */
export async function askOnTerminal(question: string): Promise<string | null> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((resolve) => {
      lines.once("close", () => resolve(null));
      void lines.question(question).then(resolve);
    });
  } finally {
    lines.close();
  }
}

/** Classifies `path` as a source directory, a thin `.loop` or a packed `.loop`. */
export async function classifyInput(path: string): Promise<InputKind> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw inputError(error, path);
  });
  if (info.isDirectory()) return "directory";
  if (!info.isFile()) throw new InputError(`not a file or a directory: ${path}`);
  return classifyFile(path);
}

/** A file is a packed `.loop` by its gzip magic, a thin one when it is text. */
async function classifyFile(path: string): Promise<InputKind> {
  const sample = await readSample(path).catch((error: NodeJS.ErrnoException) => {
    throw inputError(error, path);
  });
  if (sample.length === 0) throw new InputError(`file is empty: ${path}`);
  if (sample[0] === 0x1f && sample[1] === 0x8b) return "packed";
  if (!isText(sample)) {
    throw new InputError(`not a packed .loop and not text: ${path}`);
  }
  return "thin";
}

/** Keeps the real reason: a missing path reads plainly, anything else keeps its errno. */
function inputError(error: NodeJS.ErrnoException, path: string): InputError {
  const reason =
    error.code === "ENOENT" ? "no such file or directory" : `cannot read (${error.code})`;
  return new InputError(`${reason}: ${path}`, { cause: error });
}

async function readSample(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * True when the sample is UTF-8 with no NUL byte. A full sample may cut a
 * character in half, so only then is a partial sequence at the end allowed.
 */
function isText(sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(sample, { stream: sample.length === SAMPLE_BYTES });
    return true;
  } catch {
    return false;
  }
}
