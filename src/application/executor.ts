/**
 * The executor interface: where and how a step's processes start (ADR 0004).
 *
 * It is internal. v1 loads no third-party code, so this is not a plugin
 * contract and it may change in any release. Step kinds (agent, command,
 * Ralph) and harness adapters are the callers; none of them starts a process
 * itself. v1 has one implementation, a local process (#12), and the scripted
 * fake the tests use.
 *
 * The executor starts, streams and stops. It never decides what an attempt
 * reported and never collects anything a step produced: that comes from the
 * data and result commands (ADR 0005), which reach the run owner over
 * `LOOPFILE_ENDPOINT`.
 *
 * The caller passes the execution context as logical values. The executor maps
 * each one to what the process sees — a real path for a local process, later a
 * mount path for Docker — and sets the `LOOPFILE_*` variables on top of the
 * inherited launch environment after clearing any execution-context values.
 * The workspace is the working directory.
 *
 * There is no pseudo-terminal: plain pipes. Stdin is closed, unless the request
 * carries text for it: that is written, then stdin is closed.
 */

import type { AttemptId, RunId, StepId } from "../domain/model.ts";

/** Time between SIGTERM and SIGKILL when the whole process group is stopped (ADR 0008). */
export const CANCEL_GRACE_MS = 10_000;

/** The execution context protocol version, `LOOPFILE_PROTOCOL_VERSION` (ADR 0006). */
export const CONTEXT_PROTOCOL_VERSION = 1;

/** Every environment variable owned by the execution context contract (ADR 0005). */
export const CONTEXT_VARIABLE_NAMES = [
  "LOOPFILE_RUN_ID",
  "LOOPFILE_ATTEMPT_ID",
  "LOOPFILE_STEP",
  "LOOPFILE_PROTOCOL_VERSION",
  "LOOPFILE_WORKSPACE",
  "LOOPFILE_SCRATCH",
  "LOOPFILE_ENDPOINT",
  "LOOPFILE_ATTEMPT_SECRET",
  "LOOPFILE_ITERATION",
] as const;

/** The workspace root, as a logical value the executor maps to what the process sees. */
export type WorkspacePath = string;

/** A writable folder in the attempt folder. Nothing in it is collected. */
export type ScratchPath = string;

/** Opaque value the data and result commands use to reach the run owner. */
export type Endpoint = string;

/** Random value made for one attempt, or one Ralph iteration. */
export type AttemptSecret = string;

/**
 * One attempt's context as logical values (ADR 0005).
 *
 * A Ralph step runs one process per iteration, each with its own secret, so
 * this describes what is running now rather than the whole attempt.
 */
export interface ExecutionContext {
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly stepId: StepId;
  /** Also the process's working directory. */
  readonly workspace: WorkspacePath;
  readonly scratch: ScratchPath;
  readonly endpoint: Endpoint;
  readonly attemptSecret: AttemptSecret;
  /** The Ralph iteration this process is, from 1. The run owner answers only the iteration running now. */
  readonly iteration?: number;
}

/**
 * The `LOOPFILE_*` variables of one context (ADR 0005). The values are the
 * logical ones: an executor whose processes see other paths maps them first.
 */
export function contextEnvironment(context: ExecutionContext): Record<string, string> {
  return {
    LOOPFILE_RUN_ID: context.runId,
    LOOPFILE_ATTEMPT_ID: context.attemptId,
    LOOPFILE_STEP: context.stepId,
    LOOPFILE_PROTOCOL_VERSION: String(CONTEXT_PROTOCOL_VERSION),
    LOOPFILE_WORKSPACE: context.workspace,
    LOOPFILE_SCRATCH: context.scratch,
    LOOPFILE_ENDPOINT: context.endpoint,
    LOOPFILE_ATTEMPT_SECRET: context.attemptSecret,
    ...(context.iteration === undefined ? {} : { LOOPFILE_ITERATION: String(context.iteration) }),
  };
}

/** What to start. */
export interface StartRequest {
  /** The program. Never a shell line: a command step's shell is `sh` with its own arguments. */
  readonly command: string;
  /** Argument boundaries are kept as given. Nothing here is parsed or split. */
  readonly args: readonly string[];
  readonly context: ExecutionContext;
  /** Written to the process's stdin, which is then closed. Left out means stdin is closed at once. */
  readonly stdin?: string;
}

/** How a process that did start ended. */
export type Ended =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signalled"; readonly signal: NodeJS.Signals };

/** A process that never started, such as a command that is not on the path. */
export interface StartFailure {
  readonly kind: "start-failed";
  readonly message: string;
  /** The errno name when there is one, such as `ENOENT`. */
  readonly code?: string;
}

/** A running process, in its own process group. */
export interface RunningProcess {
  readonly kind: "running";
  /** Recorded by `attempt.started`, and what cancel and a leftover check use. */
  readonly processGroupId: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Settles when the process ends. It reports an end, so it never rejects. */
  readonly ended: Promise<Ended>;
  /** Stops the whole group: SIGTERM, then SIGKILL after `CANCEL_GRACE_MS`. Safe to call twice. */
  cancel(): void;
}

/**
 * A started process, or the reason it never started.
 *
 * A failed start is its own result rather than a made-up exit code, because a
 * command that is not there and a command that ran and failed are different
 * things to a caller.
 */
export type StartResult = RunningProcess | StartFailure;

/** Starts a step's processes. One implementation per place they can run. */
export interface Executor {
  start(request: StartRequest): Promise<StartResult>;
}
