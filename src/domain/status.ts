/**
 * The v1 status projection type (`status.json`, ADR 0007).
 *
 * This is the compact, derived view of one run's state: the body of
 * `status --json`, and each row of `list --json`. The run owner is the only
 * writer (#48); every other command only reads it (`status`, `list`, `tail`,
 * the monitor — #36, #49, #52). Resume never reads it and deleting it loses
 * nothing (ADR 0007), so nothing here is a source of truth.
 *
 * Every field is always present. For a harness metric, `null` means unknown
 * and a number, including `0`, is a value the harness reported; a harness
 * adapter never estimates one (ADR 0007). No field holds a run folder path,
 * so a consumer needs none to use this file.
 *
 * The shape and every open choice from the originating issue (#46) were
 * settled in #90:
 *
 * - **Name style:** camelCase for every field in `status.json`,
 *   `status --json` and `list --json`, the same as the manifest. Enum values
 *   stay lowercase with underscores.
 * - **`waiting`:** dropped. No v1 step kind (`agent`, `ralph`, `command` —
 *   `src/domain/model.ts`) waits on a person or an external event, so nothing
 *   in the runtime could ever produce it. `state` holds exactly the four
 *   values a run can actually be in; add `waiting` back only once a step kind
 *   needs it.
 * - **`metrics` scope:** totals for the run, not the current attempt. They
 *   sit beside `current`, not inside it, and a total survives the attempt
 *   that produced it — a reader watching a step retry does not want the
 *   count to reset to `null` between attempts.
 * - **`loopfileName`, no model digest:** only resume needs the model digest,
 *   and resume reads `run.created`, not `status.json` (ADR 0006, ADR 0007).
 *   The one-field `loopfile` object is flattened to `loopfileName`.
 */

import type { LoopEndReason, Timestamp, TransitionCause } from "./events.ts";
import type { AttemptId, HarnessName, LoopId, Outcome, RunId, StepId, Target } from "./model.ts";

/** The status format version this tool writes (ADR 0006). */
export const STATUS_FORMAT_VERSION = 1;

/** Every state a run can actually be observed in. Never `crashed` or `unknown`; a reader derives those (ADR 0007). */
export type RunLifecycle = "running" | "completed" | "failed" | "cancelled";

/** Every value `RunLifecycle` may hold, for a runtime check against a parsed file. */
export const RUN_LIFECYCLE_STATES: ReadonlySet<string> = new Set<RunLifecycle>([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/** Why a run ended. Readers pass through values from newer writers; `null` while running. */
export type StatusEndReason = string;

/** Known end reasons written by this version, for tests and writer-side documentation. */
export const STATUS_END_REASONS: ReadonlySet<string> = new Set<StatusEndReason>([
  "success",
  "failure",
  "attempt_limit",
  "transition_limit",
  "run_timeout",
  "internal_error",
  "cancelled",
]);

/** A step kind, repeated here so a consumer needs no import from the workflow model. */
export type StatusStepKind = "agent" | "ralph" | "command";

/** Every value `StatusStepKind` may hold, for a runtime check against a parsed file. */
export const STATUS_STEP_KINDS: ReadonlySet<string> = new Set<StatusStepKind>([
  "agent",
  "ralph",
  "command",
]);

/** Every value `TransitionCause` may hold, for a runtime check against a parsed file. */
export const TRANSITION_CAUSES: ReadonlySet<string> = new Set<TransitionCause>([
  "on",
  "onFailure",
  "next",
]);

/**
 * The attempt in progress. `null` when no attempt is running, for example
 * between a transition and the next attempt's start.
 */
export interface CurrentAttempt {
  readonly stepId: StepId;
  readonly stepKind: StatusStepKind;
  readonly attemptId: AttemptId;
  /** This step's attempt count so far, including this one. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** `null` on a step that is not a Ralph step. */
  readonly iteration: number | null;
  /** `null` on a step that is not a Ralph step. */
  readonly maxIterations: number | null;
  /** `null` on a command step. */
  readonly harness: HarnessName | null;
  readonly startedAt: Timestamp;
}

/** One step's visit count so far, oldest visited first. */
export interface VisitedStep {
  readonly stepId: StepId;
  readonly attempts: number;
}

/** The most recent transition, or `null` before the first one. */
export interface LastTransition {
  readonly from: StepId;
  /** A step ID or an end state. */
  readonly to: Target;
  readonly cause: TransitionCause;
  /** Holds the outcome for an `on` transition; `null` for `onFailure` or `next`. */
  readonly outcome: Outcome | null;
}

/**
 * Run metrics. The five usage fields are sums of harness-call reports from
 * ended attempts plus the live current attempt; `null` means no report supplied
 * a number, and `0` is a reported value (ADR 0007). Permission denials remain
 * the current attempt's reported count.
 */
export interface StatusMetrics {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly toolCalls: number | null;
  readonly permissionDenials: number | null;
}

/** The loop status format this tool writes (ADR 0006). */
export const LOOP_STATUS_FORMAT_VERSION = 1;

/** States written to a loop's status projection. */
export type LoopLifecycle = "running" | "completed" | "cancelled" | "failed";

/** The compact source description held in loop status. */
export type LoopStatusSource =
  | { readonly kind: "times" | "list"; readonly count: number }
  | { readonly kind: "next"; readonly command: string };

/** `status.json`: the status projection of one loop. */
export interface LoopStatus {
  readonly formatVersion: typeof LOOP_STATUS_FORMAT_VERSION;
  readonly seq: number;
  readonly loopId: LoopId;
  readonly loopfileName: string;
  readonly state: LoopLifecycle;
  readonly source: LoopStatusSource;
  readonly place: number | null;
  readonly runs: number;
  readonly retries: number;
  readonly runIds: readonly RunId[];
  readonly currentRunId: RunId | null;
  readonly pausedUntil: Timestamp | null;
  readonly cancelRequested: "now" | "after_run" | null;
  readonly endReason: LoopEndReason | null;
  readonly cancelMode: "now" | "after_run" | null;
  readonly detail: string | null;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp | null;
}

/** `status.json`: the status projection (ADR 0007). */
export interface StatusProjection {
  readonly formatVersion: typeof STATUS_FORMAT_VERSION;
  /** The last event `seq` this projection includes. */
  readonly seq: number;
  readonly updatedAt: Timestamp;
  readonly runId: RunId;
  readonly loopfileName: string;
  /** The loop that started this run, or `null` for a plain run. */
  readonly loopId: string | null;
  readonly loopIndex: number | null;
  readonly state: RunLifecycle;
  readonly endReason: StatusEndReason | null;
  readonly startedAt: Timestamp;
  /** `null` while `state` is `running`. */
  readonly endedAt: Timestamp | null;
  readonly current: CurrentAttempt | null;
  readonly lastActivityAt: Timestamp;
  /** Short harness progress text. `null` when none has arrived yet. */
  readonly lastProgress: string | null;
  readonly visitedSteps: readonly VisitedStep[];
  readonly lastTransition: LastTransition | null;
  readonly transitions: number;
  /** The workflow's `maxTransitions`. `null` when the workflow declares no limit. */
  readonly maxTransitions: number | null;
  readonly metrics: StatusMetrics;
}
