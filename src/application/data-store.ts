/**
 * Decides puts and gets in the run's data layer, and rebuilds the latest value
 * per key from the event log (#18, ADR 0003).
 *
 * A data key is `<stepId>.<name>`: an attempt may put only under its own step,
 * and `input` is reserved for the run's launch inputs (#82). The whole rule is
 * checked here, against the run's events, so it is tested without a file. The
 * only caller is `src/adapters/data-store.ts`, which writes the value into the
 * putting attempt's folder and appends the event this module builds.
 *
 * The latest value for a key is the attempt ID of the last `data.put` event
 * for that key: earlier values are never overwritten, so replaying the log
 * after a resume finds the same one (ADR 0003).
 */

import { createHash } from "node:crypto";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId, StepId } from "../domain/model.ts";
import { NAME_PATTERN } from "../domain/model.ts";

/** A data key split into the step it belongs to and its short name. */
export interface DataKey {
  readonly stepId: StepId;
  readonly name: string;
}

/** Step ID no step may put under: it holds the run's launch inputs (#82). */
export const RESERVED_DATA_STEP_ID = "input";

/** `<stepId>.<name>`, both matching `NAME_PATTERN`. */
const KEY_PATTERN = /^([a-z][a-z0-9_-]{0,63})\.([a-z][a-z0-9_-]{0,63})$/;

/** Splits `key` into its step ID and name, or nothing when it is not shaped that way. */
export function parseDataKey(key: string): DataKey | undefined {
  const match = KEY_PATTERN.exec(key);
  return match ? { stepId: match[1] as StepId, name: match[2] as string } : undefined;
}

/** The SHA-256 digest a data event records, as lowercase hex. */
export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Why a put is refused, closed so a caller can pick a step error code without parsing text. */
export type PutRefusalKind = "stale_attempt" | "invalid_key" | "write_kind_mismatch";

/** Whether a put may go ahead, or the reason it is refused. */
export type PutCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: PutRefusalKind; readonly reason: string };

/**
 * Checks a put against the run so far: the attempt exists, has not ended, the
 * key names that attempt's own step, and (`loopfile data append`, #20) the key
 * has not already been written the other way. `NAME_PATTERN` already keeps a
 * manifest from declaring a step called `input`, but the check is repeated
 * here so the rule holds even if that ever stops being true.
 */
export function checkPut(
  events: readonly RunEvent[],
  attemptId: AttemptId,
  key: string,
  appended = false,
): PutCheck {
  const stepId = stepIdOf(events, attemptId);
  if (stepId === undefined) return refuse("stale_attempt", `no such attempt: ${attemptId}`);
  if (hasEnded(events, attemptId)) {
    return refuse("stale_attempt", `attempt has ended, cannot put: ${attemptId}`);
  }
  return checkKey(events, attemptId, stepId, key, appended);
}

/** The key-shape, ownership and mixing checks, once the attempt is known to be live. */
function checkKey(
  events: readonly RunEvent[],
  attemptId: AttemptId,
  stepId: StepId,
  key: string,
  appended: boolean,
): PutCheck {
  const parsed = parseDataKey(key);
  if (parsed === undefined) {
    return refuse(
      "invalid_key",
      `not a data key, expected <step>.<name> matching ${NAME_PATTERN}: ${key}`,
    );
  }
  if (parsed.stepId === RESERVED_DATA_STEP_ID) {
    return refuse(
      "invalid_key",
      `${RESERVED_DATA_STEP_ID}.* is reserved for launch inputs: ${key}`,
    );
  }
  if (parsed.stepId !== stepId) {
    return refuse(
      "invalid_key",
      `attempt ${attemptId} may put only under its own step (${stepId}): ${key}`,
    );
  }
  return checkWriteKind(events, key, appended);
}

/** Refuses a put/append that would mix write kinds on one key (`loopfile data append`, #20, #96). */
function checkWriteKind(events: readonly RunEvent[], key: string, appended: boolean): PutCheck {
  const existingKind = writeKindOf(events, key);
  const requestedKind = appended ? "appended" : "put";
  if (existingKind === undefined || existingKind === requestedKind) return { ok: true };

  const usedCommand = existingKind === "appended" ? "data append" : "data put";
  return refuse(
    "write_kind_mismatch",
    `${key} was first written with ${usedCommand}; use the same command for every write to this key`,
  );
}

/** The attempt ID that made the last `data.put` for `key`, or nothing if it has no value. */
export function latestPut(events: readonly RunEvent[], key: string): AttemptId | undefined {
  const put = events.findLast(
    (event): event is Extract<RunEvent, { type: "data.put" }> =>
      event.type === "data.put" && event.key === key,
  );
  return put?.attemptId;
}

/**
 * Where a get reads `key` from: a launch input's file, or the attempt whose
 * put was last for the key, at that write's own index. Nothing when the key
 * has no value.
 *
 * A launch input is never put through this module (#82: the run owner writes
 * it once, straight to `inputs/<name>`, before any step runs), so `input.*`
 * is read from there instead of from `latestPut`, which is why the check
 * looks at the key itself before it looks at the event log.
 */
export type GetSource =
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "attempt"; readonly attemptId: AttemptId; readonly writeIndex?: number };

export function sourceOfGet(events: readonly RunEvent[], key: string): GetSource | undefined {
  const parsed = parseDataKey(key);
  if (parsed?.stepId === RESERVED_DATA_STEP_ID) return { kind: "input", name: parsed.name };
  const put = events.findLast(
    (event): event is Extract<RunEvent, { type: "data.put" }> =>
      event.type === "data.put" && event.key === key,
  );
  return put === undefined
    ? undefined
    : { kind: "attempt", attemptId: put.attemptId, writeIndex: put.writeIndex };
}

/**
 * How many of `attemptId`'s own writes to `key` came before the one about to
 * happen (#20): a plain put never needs this, because a later attempt writes
 * into its own data folder anyway, but two `data append` calls in the same
 * attempt would otherwise land on the same path and the second would
 * silently overwrite the first's bytes.
 */
export function writeIndexOf(
  events: readonly RunEvent[],
  attemptId: AttemptId,
  key: string,
): number {
  return events.filter(
    (event) => event.type === "data.put" && event.attemptId === attemptId && event.key === key,
  ).length;
}

/** Every key `attemptId` has put, from its own `data.put` events. */
export function putsBy(events: readonly RunEvent[], attemptId: AttemptId): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type === "data.put" && event.attemptId === attemptId) keys.add(event.key);
  }
  return keys;
}

function stepIdOf(events: readonly RunEvent[], attemptId: AttemptId): StepId | undefined {
  const started = events.find(
    (event): event is Extract<RunEvent, { type: "attempt.started" }> =>
      event.type === "attempt.started" && event.attemptId === attemptId,
  );
  return started?.stepId;
}

function hasEnded(events: readonly RunEvent[], attemptId: AttemptId): boolean {
  return events.some(
    (event) =>
      (event.type === "attempt.ended" || event.type === "attempt.interrupted") &&
      event.attemptId === attemptId,
  );
}

/** Whether `key`'s last write was a plain put or a `data append` (#96), or nothing if never written. */
function writeKindOf(events: readonly RunEvent[], key: string): "put" | "appended" | undefined {
  const last = events.findLast(
    (event): event is Extract<RunEvent, { type: "data.put" }> =>
      event.type === "data.put" && event.key === key,
  );
  if (last === undefined) return undefined;
  return last.appended ? "appended" : "put";
}

function refuse(kind: PutRefusalKind, reason: string): PutCheck {
  return { ok: false, kind, reason };
}
