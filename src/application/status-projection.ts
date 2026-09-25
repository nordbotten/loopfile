/**
 * Building a `StatusProjection` from a run's events and live harness data
 * (#48, ADR 0007).
 *
 * `projectStatus` is pure: events plus a workflow, a loopfile name and live
 * harness data go in, a `StatusProjection` comes out. It touches no file and
 * no clock but the `updatedAt` it is given, so a test can build one from a
 * handful of events without a run owner, an event log or a filesystem. The
 * atomic write to `status.json` is `adapters/status-writer.ts`; this module
 * only ever decides what the file should say.
 *
 * `replay` (`application/replay.ts`) already answers the run-wide questions —
 * attempts per step, transitions, how the run ended. What it does not answer
 * is "is an attempt running right now, and since when", because that is not a
 * question routing or the attempt limit ever needs to ask; this module answers
 * it itself with one pass over the same events.
 */

import type { CallFields, RunEvent, Timestamp } from "../domain/events.ts";
import { isHarnessName } from "../domain/harnesses.ts";
import type { Step, StepId, Workflow } from "../domain/model.ts";
import {
  type CurrentAttempt,
  type LastTransition,
  type RunLifecycle,
  STATUS_FORMAT_VERSION,
  type StatusEndReason,
  type StatusMetrics,
  type StatusProjection,
  type StatusStepKind,
  type VisitedStep,
} from "../domain/status.ts";
import { type RunResult, replay } from "./replay.ts";

/** Live harness data (ADR 0007): last activity, short progress text and current-attempt metrics. */
export interface HarnessData {
  /** `null` before the harness has reported anything. */
  readonly lastActivityAt: Timestamp | null;
  readonly lastProgress: string | null;
  readonly metrics: StatusMetrics;
}

/** Every metric unknown. What a fresh run starts with, and what a `null` harness field means. */
export const UNKNOWN_METRICS: StatusMetrics = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  toolCalls: null,
  permissionDenials: null,
};

/** No harness data yet: on start or resume, before the harness reports anything again (ADR 0007). */
export const NO_HARNESS_DATA: HarnessData = {
  lastActivityAt: null,
  lastProgress: null,
  metrics: UNKNOWN_METRICS,
};

/** Adds one harness report to a metrics sum; unknown usage values do not erase known values. */
export function addMetrics(soFar: StatusMetrics, report: StatusMetrics): StatusMetrics {
  return {
    inputTokens: addMetric(soFar.inputTokens, report.inputTokens),
    outputTokens: addMetric(soFar.outputTokens, report.outputTokens),
    totalTokens: addMetric(soFar.totalTokens, report.totalTokens),
    costUsd: addMetric(soFar.costUsd, report.costUsd),
    toolCalls: addMetric(soFar.toolCalls, report.toolCalls),
    // Denials describe the current attempt; keep the existing attempt-local behavior.
    permissionDenials: report.permissionDenials ?? null,
  };
}

/** Sums the metrics on completed attempts; old attempts without the field are unknown. */
export function sumAttemptMetrics(events: readonly RunEvent[]): StatusMetrics {
  let metrics = UNKNOWN_METRICS;
  for (const event of events) {
    if (event.type === "attempt.ended") {
      metrics = addMetrics(metrics, event.metrics ?? UNKNOWN_METRICS);
    }
  }
  return metrics;
}

function addMetric(soFar: number | null, report: number | null): number | null {
  if (soFar === null) return report;
  if (report === null) return soFar;
  return soFar + report;
}

/** What `projectStatus` needs beyond the events and the harness data. */
export interface ProjectStatusContext {
  readonly workflow: Workflow;
  /** No event carries this (`run.created` has no loopfile name), so the caller supplies it. */
  readonly loopfileName: string;
  /** The status write's own time. Never read from the clock inside this module. */
  readonly updatedAt: Timestamp;
}

/**
 * Builds the status projection this run's owner should write next.
 *
 * `events` must be a valid run log: it starts with `run.created`, the same
 * rule `replay` enforces. `harnessData` carries what no event does — the
 * harness's own activity time, progress text and current-attempt metrics.
 */
export function projectStatus(
  events: readonly RunEvent[],
  context: ProjectStatusContext,
  harnessData: HarnessData = NO_HARNESS_DATA,
): StatusProjection {
  const state = replay(events);
  const open = openAttempt(events);
  const lifecycle = lifecycleOf(state.result);
  const endedMetrics = sumAttemptMetrics(events);

  return {
    formatVersion: STATUS_FORMAT_VERSION,
    seq: events.at(-1)?.seq ?? 0,
    updatedAt: context.updatedAt,
    runId: state.runId,
    loopfileName: context.loopfileName,
    ...loopFields(events[0]),
    ...remoteField(events[0]),
    state: lifecycle.state,
    endReason: lifecycle.endReason,
    startedAt: state.createdAt,
    endedAt: lifecycle.state === "running" ? null : state.lastEventAt,
    current: open === undefined ? null : currentAttempt(open, context.workflow),
    lastActivityAt: harnessData.lastActivityAt ?? state.lastEventAt,
    lastProgress: harnessData.lastProgress,
    visitedSteps: visitedSteps(state.attempts),
    lastTransition: lastTransition(state.transitions),
    transitions: state.transitions.length,
    maxTransitions: context.workflow.maxTransitions ?? null,
    metrics: open === undefined ? endedMetrics : addMetrics(endedMetrics, harnessData.metrics),
  };
}

function remoteField(event: RunEvent | undefined): Pick<StatusProjection, "remote"> {
  return event?.type === "run.created" && event.remote !== undefined
    ? { remote: event.remote }
    : {};
}

function loopFields(event: RunEvent | undefined): Pick<StatusProjection, "loopId" | "loopIndex"> {
  if (event?.type !== "run.created") return { loopId: null, loopIndex: null };
  return { loopId: event.loopId ?? null, loopIndex: event.loopIndex ?? null };
}

/** One attempt with a start and no end yet, found by one pass over the events. */
interface OpenAttempt {
  readonly stepId: StepId;
  readonly attemptId: string;
  readonly startedAt: Timestamp;
  /** This step's attempt count so far, including this one (`current.attempt`). */
  readonly attempt: number;
  readonly iteration: number;
  readonly fields?: CallFields;
}

/** `openAttempt`'s running state as it scans the events, one event at a time. */
interface OpenAttemptScan {
  open: Omit<OpenAttempt, "iteration"> | undefined;
  iteration: number;
  /** This step's attempt count so far, the same way `replay`'s own `attemptsPerStep` counts it. */
  readonly attemptsPerStep: Map<StepId, number>;
}

/**
 * The attempt currently running, or `undefined` between a transition and the
 * next attempt's start, and once the run has ended.
 *
 * `attempt.started` opens one; `attempt.ended` or `attempt.interrupted` closes
 * it. `iteration.started` only ever belongs to the open attempt, because a
 * step's attempts run one at a time, so counting them since the open attempt
 * began is the iteration number a Ralph step is on.
 */
function openAttempt(events: readonly RunEvent[]): OpenAttempt | undefined {
  const scan: OpenAttemptScan = { open: undefined, iteration: 0, attemptsPerStep: new Map() };
  for (const event of events) applyToOpenAttempt(scan, event);
  return scan.open === undefined ? undefined : { ...scan.open, iteration: scan.iteration };
}

function applyToOpenAttempt(scan: OpenAttemptScan, event: RunEvent): void {
  switch (event.type) {
    case "attempt.started":
      startAttempt(scan, event);
      return;
    case "attempt.ended":
    case "attempt.interrupted":
      scan.open = undefined;
      return;
    case "iteration.started":
      countIteration(scan, event);
      return;
    default:
      return;
  }
}

function startAttempt(
  scan: OpenAttemptScan,
  event: Extract<RunEvent, { type: "attempt.started" }>,
): void {
  const attempt = (scan.attemptsPerStep.get(event.stepId) ?? 0) + 1;
  scan.attemptsPerStep.set(event.stepId, attempt);
  scan.open = {
    stepId: event.stepId,
    attemptId: event.attemptId,
    startedAt: event.at,
    attempt,
    ...(event.fields === undefined ? {} : { fields: event.fields }),
  };
  scan.iteration = 0;
}

function countIteration(
  scan: OpenAttemptScan,
  event: Extract<RunEvent, { type: "iteration.started" }>,
): void {
  if (scan.open?.attemptId !== event.attemptId) return;
  scan.iteration += 1;
  scan.open = {
    ...scan.open,
    ...(event.fields === undefined ? { fields: undefined } : { fields: event.fields }),
  };
}

function currentAttempt(open: OpenAttempt, workflow: Workflow): CurrentAttempt {
  const step = findStep(workflow, open.stepId);
  const isRalph = step?.kind === "ralph";
  return {
    stepId: open.stepId,
    stepKind: statusStepKind(step),
    attemptId: open.attemptId,
    attempt: open.attempt,
    maxAttempts: step?.maxAttempts ?? 0,
    iteration: isRalph ? open.iteration : null,
    maxIterations: step?.kind === "ralph" ? step.maxIterations : null,
    harness: harnessFromFields(open.fields),
    startedAt: open.startedAt,
  };
}

function findStep(workflow: Workflow, stepId: StepId): Step | undefined {
  return workflow.steps.find((step) => step.id === stepId);
}

function statusStepKind(step: Step | undefined): StatusStepKind {
  return step?.kind ?? "command";
}

function harnessFromFields(fields: CallFields | undefined) {
  return fields?.harness !== undefined && isHarnessName(fields.harness) ? fields.harness : null;
}

/**
 * A run result read as the lifecycle `status.json` records: the state and the
 * reason. Exported because `run-end.ts` reads the same result straight off
 * the end event, without a projection to hand (#185).
 */
export function lifecycleOf(result: RunResult | undefined): {
  state: RunLifecycle;
  endReason: StatusEndReason | null;
} {
  if (result === undefined) return { state: "running", endReason: null };
  if (result.result === "cancelled") return { state: "cancelled", endReason: "cancelled" };
  const state: RunLifecycle = result.result === "success" ? "completed" : "failed";
  const endReason: StatusEndReason = result.reason === "end_state" ? result.result : result.reason;
  return { state, endReason };
}

function visitedSteps(
  attempts: Readonly<Record<StepId, readonly string[]>>,
): readonly VisitedStep[] {
  return Object.entries(attempts).map(([stepId, ids]) => ({ stepId, attempts: ids.length }));
}

function lastTransition(
  transitions: ReturnType<typeof replay>["transitions"],
): LastTransition | null {
  const last = transitions.at(-1);
  if (last === undefined) return null;
  return { from: last.from, to: last.to, cause: last.cause, outcome: last.outcome ?? null };
}
