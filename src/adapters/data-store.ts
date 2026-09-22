/**
 * The run's data store: puts and gets data keys (#18, ADR 0004).
 *
 * A plain module, not an interface: v1 has one data store. What a put is
 * allowed to do is decided in `application/data-store.ts`, against the run's
 * events so far; this file writes values into the putting attempt's folder,
 * keeps an aggregate for appended values, and appends the event that decision
 * produced. Events never hold content (ADR 0003): a get reads the value
 * straight from the attempt folder
 * of whichever attempt's `data.put` was last for that key, or, for an
 * `input.<name>` key, from the run's `inputs/<name>` (#82) — a launch input
 * is never put, so a step cannot tell one apart from any other key.
 *
 * Called only by the run owner, which holds the run's events and passes them
 * in as `history` on every call. It grows by one event each call, oldest
 * first, so a resume that replays the whole log sees the same latest value a
 * live run would have.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkPut,
  type PutRefusalKind,
  sha256,
  sourceOfGet,
  writeIndexOf,
} from "../application/data-store.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId } from "../domain/model.ts";
import { attemptPaths } from "./attempt-directory.ts";
import type { EventLog } from "./event-log.ts";

/**
 * Thrown when a put is refused, or a get finds no value. The message says
 * why. `kind` is set only for a refused put (#20); a get's "no value" has none.
 */
export class DataStoreError extends Error {
  readonly kind?: PutRefusalKind;

  constructor(message: string, kind?: PutRefusalKind) {
    super(message);
    this.kind = kind;
  }
}

export interface PutOptions {
  readonly events: EventLog;
  /** The run's events so far, oldest first. */
  readonly history: readonly RunEvent[];
  readonly attemptsFolder: string;
  /** The attempt making the put. The key must name this attempt's own step. */
  readonly attemptId: AttemptId;
  readonly key: string;
  readonly content: Uint8Array;
  /** `loopfile data append` (#20, #96): marks the key so a reader joins its whole history. */
  readonly appended?: boolean;
}

/**
 * Writes `content` into the putting attempt's folder and appends `data.put`.
 * Throws a `DataStoreError` without writing anything when the put is refused.
 */
export async function put(options: PutOptions): Promise<RunEvent> {
  const check = checkPut(
    options.history,
    options.attemptId,
    options.key,
    options.appended === true,
  );
  if (!check.ok) throw new DataStoreError(check.reason, check.kind);

  // A later attempt writes into its own data folder, so only two appends
  // from the *same* attempt to the same key can collide on disk; a plain put
  // never needs an index (#20).
  const writeIndex =
    options.appended === true
      ? writeIndexOf(options.history, options.attemptId, options.key)
      : undefined;
  const path = dataFile(options.attemptsFolder, options.attemptId, options.key, writeIndex);
  await writeFile(path, options.content);
  if (options.appended === true)
    await appendHistory(options.attemptsFolder, options.key, options.content);
  return await options.events.append({
    type: "data.put",
    attemptId: options.attemptId,
    key: options.key,
    size: options.content.byteLength,
    digest: sha256(options.content),
    ...(options.appended === true ? { appended: true, writeIndex } : {}),
  });
}

export interface GetOptions {
  readonly events: EventLog;
  /** The run's events so far, oldest first. */
  readonly history: readonly RunEvent[];
  readonly attemptsFolder: string;
  /** `RunPaths.inputs`: where the run's launch inputs sit, one file per name (#82). */
  readonly inputsFolder: string;
  /** The attempt making the get, recorded on the `data.get` event. */
  readonly attemptId: AttemptId;
  readonly key: string;
}

/** What a get read back: the bytes, and the `data.get` event appended for it. */
export interface GetResult {
  readonly content: Buffer;
  readonly event: RunEvent;
}

/**
 * Reads the newest value of `key` and appends `data.get`. Throws when it has
 * none: a plain data key with no put yet, or an `input.<name>` nothing wrote.
 */
export async function get(options: GetOptions): Promise<GetResult> {
  const source = sourceOfGet(options.history, options.key);
  if (source === undefined) throw new DataStoreError(`no value for key: ${options.key}`);

  const path =
    source.kind === "input"
      ? join(options.inputsFolder, source.name)
      : dataFile(options.attemptsFolder, source.attemptId, options.key, source.writeIndex);
  const content = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DataStoreError(`no value for key: ${options.key}`);
    throw error;
  });
  const event = await options.events.append({
    type: "data.get",
    attemptId: options.attemptId,
    key: options.key,
    size: content.byteLength,
    digest: sha256(content),
  });
  return { content, event };
}

/**
 * Where one key's value sits inside the attempt that put it. `writeIndex`
 * (set only for an appended write past the attempt's first) gives each of an
 * attempt's own writes to the same key a distinct path, so a later one never
 * overwrites an earlier one's bytes (#20).
 */
export function dataFile(
  attemptsFolder: string,
  attemptId: AttemptId,
  key: string,
  writeIndex?: number,
): string {
  const base = join(attemptPaths(attemptsFolder, attemptId).data, key);
  return writeIndex ? `${base}@${writeIndex}` : base;
}

/** One stable file containing an appended key's whole history, joined like a prompt value. */
export function appendedDataFile(attemptsFolder: string, key: string): string {
  return join(attemptsFolder, "..", "result-values", key);
}

async function appendHistory(
  attemptsFolder: string,
  key: string,
  content: Uint8Array,
): Promise<void> {
  const path = appendedDataFile(attemptsFolder, key);
  const previous = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    previous === undefined ? content : Buffer.concat([previous, Buffer.from("\n"), content]),
  );
}
