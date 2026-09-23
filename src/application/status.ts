/**
 * Validating a parsed `status.json` against the v1 status projection shape
 * (`src/domain/status.ts`, ADR 0007).
 *
 * Every required field of `StatusProjection` is always present (the optional
 * `remote` field is absent on local runs), so a consumer that skips this check
 * would otherwise have to treat "missing" and "`null`" as
 * the same thing everywhere it reads the file. This throws instead, the same
 * way `parseEventLog` (`src/application/replay.ts`) throws on a broken event
 * log rather than hand a caller a partial one.
 */

import { isRemoteRecord } from "../domain/events.ts";
import {
  RUN_LIFECYCLE_STATES,
  STATUS_FORMAT_VERSION,
  STATUS_STEP_KINDS,
  type StatusProjection,
  TRANSITION_CAUSES,
} from "../domain/status.ts";

/** Thrown when a parsed value does not have the v1 status projection shape. */
export class InvalidStatusProjectionError extends Error {}

/**
 * Parses and validates `value` as a v1 `StatusProjection`.
 *
 * Checks that every field the type declares is present with the right shape.
 * It does not check that IDs it cannot verify without a run's own event log
 * (for example that `current.stepId` names a real step) are correct — only
 * that the projection itself is well-formed.
 */
export function parseStatusProjection(value: unknown): StatusProjection {
  const record = asRecord(value, "status.json");
  if (record.formatVersion !== STATUS_FORMAT_VERSION) {
    throw new InvalidStatusProjectionError(
      `status.json formatVersion must be ${STATUS_FORMAT_VERSION}, got ${JSON.stringify(record.formatVersion)}`,
    );
  }
  requireNumber(record, "seq");
  requireString(record, "updatedAt");
  requireString(record, "runId");
  requireString(record, "loopfileName");
  const loopId = optionalString(record, "loopId");
  const loopIndex = optionalLoopIndex(record);
  const remote = optionalRemote(record);
  requireEnum(record, "state", RUN_LIFECYCLE_STATES);
  requireNullOr(record, "endReason", (v) => requireStringValue(v, "endReason"));
  requireString(record, "startedAt");
  requireNullOr(record, "endedAt", (v) => requireStringValue(v, "endedAt"));
  requireNullOr(record, "current", checkCurrent);
  requireString(record, "lastActivityAt");
  requireNullOr(record, "lastProgress", (v) => requireStringValue(v, "lastProgress"));
  checkVisitedSteps(record.visitedSteps);
  requireNullOr(record, "lastTransition", checkLastTransition);
  requireNumber(record, "transitions");
  requireNullOr(record, "maxTransitions", (v) => requireNumberValue(v, "maxTransitions"));
  const metrics = checkMetrics(record.metrics);
  return {
    ...record,
    loopId,
    loopIndex,
    ...(remote === undefined ? {} : { remote }),
    ...(!("permissionDenials" in metrics)
      ? { metrics: { ...metrics, permissionDenials: null } }
      : {}),
  } as StatusProjection;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidStatusProjectionError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): void {
  requireStringValue(record[field], field);
}

function requireStringValue(value: unknown, field: string): void {
  if (typeof value !== "string") {
    throw new InvalidStatusProjectionError(
      `status.json ${field} must be a string, got ${JSON.stringify(value)}`,
    );
  }
}

function requireNumber(record: Record<string, unknown>, field: string): void {
  requireNumberValue(record[field], field);
}

function requireNumberValue(value: unknown, field: string): void {
  if (typeof value !== "number") {
    throw new InvalidStatusProjectionError(
      `status.json ${field} must be a number, got ${JSON.stringify(value)}`,
    );
  }
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  if (!(field in record) || record[field] === null) return null;
  requireString(record, field);
  return record[field] as string;
}

function optionalRemote(record: Record<string, unknown>): StatusProjection["remote"] {
  if (!("remote" in record)) return undefined;
  if (!isRemoteRecord(record.remote)) {
    throw new InvalidStatusProjectionError("status.json remote must be a remote run record");
  }
  return record.remote;
}

function optionalLoopIndex(record: Record<string, unknown>): number | null {
  if (!("loopIndex" in record) || record.loopIndex === null) return null;
  requireNumber(record, "loopIndex");
  if (!Number.isInteger(record.loopIndex) || (record.loopIndex as number) < 1) {
    throw new InvalidStatusProjectionError(
      `status.json loopIndex must be an integer of 1 or more, got ${JSON.stringify(record.loopIndex)}`,
    );
  }
  return record.loopIndex as number;
}

function requireEnum(
  record: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
): void {
  requireEnumValue(record[field], field, allowed);
}

function requireEnumValue(value: unknown, field: string, allowed: ReadonlySet<string>): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new InvalidStatusProjectionError(
      `status.json ${field} must be one of ${[...allowed].join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
}

function requireNullOr(
  record: Record<string, unknown>,
  field: string,
  check: (value: unknown) => void,
): void {
  const value = record[field];
  if (value === null) return;
  if (!(field in record)) {
    throw new InvalidStatusProjectionError(`status.json is missing ${field}`);
  }
  check(value);
}

function checkCurrent(value: unknown): void {
  const current = asRecord(value, "status.json current");
  requireString(current, "stepId");
  requireEnum(current, "stepKind", STATUS_STEP_KINDS);
  requireString(current, "attemptId");
  requireNumber(current, "attempt");
  requireNumber(current, "maxAttempts");
  requireNullOr(current, "iteration", (v) => requireNumberValue(v, "current.iteration"));
  requireNullOr(current, "maxIterations", (v) => requireNumberValue(v, "current.maxIterations"));
  requireNullOr(current, "harness", (v) => requireStringValue(v, "current.harness"));
  requireString(current, "startedAt");
}

function checkVisitedSteps(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new InvalidStatusProjectionError(
      `status.json visitedSteps must be an array, got ${JSON.stringify(value)}`,
    );
  }
  for (const entry of value) {
    const visited = asRecord(entry, "status.json visitedSteps entry");
    requireString(visited, "stepId");
    requireNumber(visited, "attempts");
  }
}

function checkLastTransition(value: unknown): void {
  const transition = asRecord(value, "status.json lastTransition");
  requireString(transition, "from");
  requireString(transition, "to");
  requireEnum(transition, "cause", TRANSITION_CAUSES);
  requireNullOr(transition, "outcome", (v) => requireStringValue(v, "lastTransition.outcome"));
}

function checkMetrics(value: unknown): Record<string, unknown> {
  const metrics = asRecord(value, "status.json metrics");
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "costUsd", "toolCalls"]) {
    requireNullOr(metrics, field, (v) => requireNumberValue(v, `metrics.${field}`));
  }
  if ("permissionDenials" in metrics) {
    requireNullOr(metrics, "permissionDenials", (v) =>
      requireNumberValue(v, "metrics.permissionDenials"),
    );
  }
  return metrics;
}
