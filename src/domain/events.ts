/**
 * The v1 event types of a run's `events.jsonl` (ADR 0003).
 *
 * The event log is the source of truth for a run: one JSON event on each line,
 * appended only by the run owner. An event is a state change or a step's call
 * to the data layer. Harness activity is not an event; it goes to the activity
 * log. Data layer events record the call, the key, the byte size and a digest,
 * never the content.
 *
 * Every event carries `seq`, which goes up by one, a timestamp and a type. The
 * first event, `run.created`, records the event format version (ADR 0006).
 *
 * These are plain, read-only, JSON-serializable records. Building state from
 * them is `replay` (`src/application/replay.ts`); writing them is the run
 * owner's append path (#28).
 */

import type {
  InputName,
  LoopId,
  Outcome,
  OutputName,
  StepId,
  Target,
  WorkspaceMode,
} from "./model.ts";
import type { StatusMetrics } from "./status.ts";

/** The event format version this tool writes (ADR 0006). */
export const EVENT_FORMAT_VERSION = 1;

/** An attempt ID, for example `007-fix`: the run-wide attempt number and the step ID. */
export type AttemptId = string;

/** An ISO 8601 timestamp with a time zone, as `Date.toISOString` writes it. */
export type Timestamp = string;

/** Fields every event has. */
interface EventBase {
  /** Goes up by one for each event in the run, starting at 1. */
  readonly seq: number;
  readonly at: Timestamp;
}

/** Where a Remote Loopfile came from and the commit that supplied it (ADR 0013). */
export interface RemoteRecord {
  readonly host: string;
  readonly repo: string;
  readonly path?: string;
  readonly ref?: string;
  readonly sha: string;
}

const REMOTE_RECORD_FIELDS = new Set(["host", "repo", "path", "ref", "sha"]);

/** True when `value` is a normalized remote run record. */
export function isRemoteRecord(value: unknown): value is RemoteRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => REMOTE_RECORD_FIELDS.has(key)) &&
    validRemoteHost(record.host) &&
    validRemoteRepo(record.repo) &&
    validRemotePath(record.path) &&
    validRemoteRef(record.ref) &&
    typeof record.sha === "string" &&
    /^[0-9a-f]{40}$/.test(record.sha)
  );
}

function validRemoteHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value === value.toLowerCase() &&
    !value.includes("@")
  );
}

function validRemoteRepo(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.toLowerCase()) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments.every(validRemotePathSegment);
}

function validRemotePath(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value.split("/").every(validRemotePathSegment);
}

function validRemotePathSegment(value: string): boolean {
  return value !== "" && value !== "." && value !== "..";
}

function validRemoteRef(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value !== "");
}

/** One launch input as it was given, recorded without its value. */
export interface LaunchInputRecord {
  readonly name: InputName;
  readonly size: number;
  readonly digest: string;
}

/**
 * The run's first event. It fixes what the rest of the log is read against:
 * the event format version, the digest of the built model that resume checks
 * (ADR 0006), and the target folder the run started from. The base commit is
 * that folder's `HEAD` at launch, which moves, so the log must hold the commit
 * the run actually started from.
 */
export interface RunCreated extends EventBase {
  readonly type: "run.created";
  readonly runId: string;
  readonly eventFormatVersion: number;
  readonly modelDigest: string;
  readonly targetFolder: string;
  /** Older run logs omit workspace fields; future non-Git modes omit branch facts. */
  readonly workspacePath?: string;
  readonly workspaceMode?: WorkspaceMode;
  readonly isolateKind?: "worktree";
  readonly baseCommit?: string;
  /** `loopfile/<runid>` for modes that create a branch. */
  readonly branch?: string;
  readonly remote?: RemoteRecord;
  readonly inputs: readonly LaunchInputRecord[];
  readonly loopId?: string;
  readonly loopIndex?: number;
}

/** A run owner took the run: at launch, and again on every resume (ADR 0008). */
export interface OwnerStarted extends EventBase {
  readonly type: "owner.started";
  readonly pid: number;
  readonly host: string;
}

/** A person continued an ended run; limits start again from this event. */
export interface RunContinued extends EventBase {
  readonly type: "run.continued";
}

/** A visit to a step began. Its process group is what cancel and a leftover check use. */
export interface AttemptStarted extends EventBase {
  readonly type: "attempt.started";
  readonly attemptId: AttemptId;
  readonly stepId: StepId;
  readonly processGroupId: number;
}

/**
 * One harness call of a Ralph step's attempt began. Iterations count from 1.
 * `processGroupId` is the harness process's group, which resume checks for
 * leftovers (ADR 0008).
 */
export interface IterationStarted extends EventBase {
  readonly type: "iteration.started";
  readonly attemptId: AttemptId;
  readonly iteration: number;
  readonly processGroupId: number;
}

/** Why one Ralph iteration stopped. Only `outcome` ends the attempt cleanly. */
export type IterationEndReason = "outcome" | "no_outcome" | "timeout" | "nonzero_exit";

export interface IterationEnded extends EventBase {
  readonly type: "iteration.ended";
  readonly attemptId: AttemptId;
  readonly iteration: number;
  readonly reason: IterationEndReason;
}

/**
 * A step called `loopfile result <outcome>` and the run owner accepted it: the
 * outcome is a key of the step's `on` and this is the first accepted call of
 * the attempt (#85). The attempt may still fail after it, for example on a
 * nonzero exit.
 */
export interface OutcomeReported extends EventBase {
  readonly type: "outcome.reported";
  readonly attemptId: AttemptId;
  /** Only a Ralph step has one. The one-outcome-per-attempt rule resets each iteration. */
  readonly iteration?: number;
  readonly outcome: Outcome;
  /** Optional, one line, at most 500 bytes (#85). Log-only: no route reads it. */
  readonly message?: string;
}

/**
 * Why a visit to a step ended.
 *
 * `outcome` and `clean_exit` are the two clean ends; every other reason fails
 * the attempt and sends it down `onFailure`. `missing_output` names the key
 * that was not put and `outcome_not_allowed` names the outcome the step
 * reported, because both are the user's mistake to read in the log.
 */
export type AttemptEndReason =
  | "outcome"
  | "clean_exit"
  | "timeout"
  | "iteration_limit"
  | "missing_output"
  | "outcome_not_allowed"
  | "nonzero_exit"
  | "start_failed";

export interface AttemptEnded extends EventBase {
  readonly type: "attempt.ended";
  readonly attemptId: AttemptId;
  readonly result: "success" | "failure";
  readonly reason: AttemptEndReason;
  /** The outcome the attempt ended on, for `outcome` and `outcome_not_allowed`. */
  readonly outcome?: Outcome;
  /** The key that was not put, for `missing_output`. */
  readonly output?: OutputName;
  /** This attempt's final harness metrics. Missing on logs written before this field existed. */
  readonly metrics?: StatusMetrics;
}

/**
 * An attempt that never ended: written on resume for an attempt that has a
 * start and no end, and by cancel (ADR 0008). It carries no reason or metrics:
 * the numbers of an interrupted attempt are lost. An interrupted attempt
 * counts toward the step's `maxAttempts` whatever interrupted it.
 */
export interface AttemptInterrupted extends EventBase {
  readonly type: "attempt.interrupted";
  readonly attemptId: AttemptId;
}

/** What moved the run: an `on` route, the step's `onFailure`, or the next step in the list. */
export type TransitionCause = "on" | "onFailure" | "next";

/**
 * One transition, written before the next attempt starts (#28). `result`,
 * `reason` and `outcome` are the attempt's own end fields, carried onto the
 * transition so replay never has to join it back to the `attempt.ended` that
 * caused it.
 */
export interface Transition extends EventBase {
  readonly type: "transition";
  readonly from: StepId;
  readonly attemptId: AttemptId;
  readonly result: "success" | "failure";
  readonly reason: AttemptEndReason;
  readonly outcome?: Outcome;
  /** A step ID or an end state. */
  readonly to: Target;
  readonly cause: TransitionCause;
}

/**
 * A step's call to the data layer, named after the command that made it, so a
 * put is `data.put` and a get is `data.get` whatever the key holds. The digest
 * proves which value the step saw without the log holding the value.
 */
interface DataEventBase extends EventBase {
  /** The attempt that made the call. */
  readonly attemptId: AttemptId;
  readonly key: string;
  readonly size: number;
  readonly digest: string;
}

export interface DataGet extends DataEventBase {
  readonly type: "data.get";
}

export interface DataPut extends DataEventBase {
  readonly type: "data.put";
  /** Written by `loopfile data append`: readers may join this key's values oldest first. */
  readonly appended?: boolean;
  /**
   * 0-based count of this attempt's own earlier writes to this key, set only
   * when `appended` is true. Two appends to the same key from the same
   * attempt would otherwise land on the same path in that attempt's data
   * folder and the second would silently overwrite the first (#20); this is
   * what keeps every append's bytes on disk, distinct from every other.
   */
  readonly writeIndex?: number;
}

/**
 * The run owner filled a prompt's placeholders for one harness call. The step
 * makes no call of its own, so without this event the read would be invisible.
 */
export type PromptValueSource =
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "attempt"; readonly attemptId: AttemptId; readonly writeIndex?: number };

export interface PromptFilled extends EventBase {
  readonly type: "prompt.filled";
  readonly attemptId: AttemptId;
  readonly stepId: StepId;
  /** Only on a Ralph step. */
  readonly iteration?: number;
  /** Each data key the fill read, and whether it had a value. */
  readonly keys: Readonly<Record<string, boolean>>;
  /** Present when the prompt reads `$history` or `$run`. */
  readonly reads?: {
    readonly values?: Readonly<Record<string, readonly PromptValueSource[]>>;
    readonly run?: readonly string[];
  };
  /** UTF-8 byte size of the filled text. */
  readonly size: number;
  /** Of the filled text. */
  readonly digest: string;
}

/** Why a run stopped. A normal end is a transition to an end state. */
export type RunEndReason =
  | "end_state"
  | "attempt_limit"
  | "transition_limit"
  | "run_timeout"
  | "internal_error";

export interface RunEnded extends EventBase {
  readonly type: "run.ended";
  readonly result: "success" | "failure";
  readonly reason: RunEndReason;
  /** The step that hit its limit, for `attempt_limit`. Left out for every other reason. */
  readonly stepId?: StepId;
  /** The final live metrics, so `tail --json` exposes them with the end event. */
  readonly metrics?: StatusMetrics;
}

/** `loopfile cancel` or a signal reached the run owner. It writes this and exits. */
export interface RunCancelled extends EventBase {
  readonly type: "run.cancelled";
  /** The final live metrics, so `tail --json` exposes them with the cancel event. */
  readonly metrics?: StatusMetrics;
}

/** Every event that may appear in a run's `events.jsonl`. */
export type RunEvent =
  | RunCreated
  | OwnerStarted
  | RunContinued
  | AttemptStarted
  | IterationStarted
  | IterationEnded
  | OutcomeReported
  | AttemptEnded
  | AttemptInterrupted
  | Transition
  | DataGet
  | DataPut
  | PromptFilled
  | RunEnded
  | RunCancelled;

/** A string-valued input set supplied to one loop child run. */
export type InputSet = Readonly<Record<string, string>>;

/** The input source from which a loop gets its child runs. */
export type LoopSource =
  | { readonly kind: "times"; readonly count: number }
  | { readonly kind: "list"; readonly sets: readonly InputSet[] }
  | { readonly kind: "next"; readonly command: string };

/** The loop event format this tool writes (ADR 0006). */
export const LOOP_EVENT_FORMAT_VERSION = 1;

export interface LoopCreated extends EventBase {
  readonly type: "loop.created";
  readonly loopId: LoopId;
  readonly eventFormatVersion: typeof LOOP_EVENT_FORMAT_VERSION;
  readonly repositoryPath: string;
  /** A CLI override carried to every child run. */
  readonly workspaceMode?: WorkspaceMode;
  readonly loopfileName: string;
  readonly source: LoopSource;
  readonly fixedInputs: InputSet;
  readonly retry: number;
  readonly maxRuns: number | null;
  readonly pauseMs: number | null;
  readonly program: { readonly version: string; readonly digest: string };
}

export interface LoopRunStarted extends EventBase {
  readonly type: "loop.run_started";
  readonly runId: string;
  readonly index: number;
  readonly inputSet: InputSet;
  readonly sourceIndex: number | null;
  readonly retryOf: string | null;
}

export interface LoopPaused extends EventBase {
  readonly type: "loop.paused";
  readonly until: Timestamp;
}

export type LoopCancelMode = "now" | "after_run";

export interface LoopCancelRequested extends EventBase {
  readonly type: "loop.cancel_requested";
  readonly mode: LoopCancelMode;
}

export type LoopEndReason =
  | "source_empty"
  | "max_runs"
  | "run_failed"
  | "source_failed"
  | "cancelled"
  | "program_changed"
  | "internal_error";

export interface LoopEnded extends EventBase {
  readonly type: "loop.ended";
  readonly result: "success" | "failure";
  readonly reason: LoopEndReason;
  /** Present only when `reason` is `cancelled`. */
  readonly cancelMode?: LoopCancelMode;
  /** Optional one-line operator detail. */
  readonly detail?: string;
  /** Present only when `reason` is `internal_error`. */
  readonly childSeq?: number | null;
}

/** Every event that may appear in a loop's `events.jsonl`. */
export type LoopEvent =
  | LoopCreated
  | OwnerStarted
  | LoopRunStarted
  | LoopPaused
  | LoopCancelRequested
  | LoopEnded;

/** Every event that may appear in either kind of event log. */
export type EventRecord = RunEvent | LoopEvent;

/** Event names accepted in a loop log. */
export const LOOP_EVENT_TYPES: ReadonlySet<string> = new Set<LoopEvent["type"]>([
  "loop.created",
  "owner.started",
  "loop.run_started",
  "loop.paused",
  "loop.cancel_requested",
  "loop.ended",
]);

/** Every event type name, so a line that is not an event can be told apart. */
export const EVENT_TYPES: ReadonlySet<string> = new Set<EventRecord["type"]>([
  "run.created",
  "owner.started",
  "run.continued",
  "attempt.started",
  "iteration.started",
  "iteration.ended",
  "outcome.reported",
  "attempt.ended",
  "attempt.interrupted",
  "transition",
  "data.get",
  "data.put",
  "prompt.filled",
  "run.ended",
  "run.cancelled",
  "loop.created",
  "loop.run_started",
  "loop.paused",
  "loop.cancel_requested",
  "loop.ended",
]);
