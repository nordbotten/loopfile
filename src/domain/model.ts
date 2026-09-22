/**
 * The v1 normalized workflow model (ADR 0002).
 *
 * The loader builds one `Workflow` from a run's materialized Loopfile and fills
 * in every default, so the runtime never sees a missing value. The runtime
 * depends only on these types: it never reads YAML and never learns which input
 * type the run came from.
 *
 * The model is plain, read-only, JSON-serializable data. It holds no YAML
 * locations, no classes and no methods. `run.created` records a digest of it
 * (ADR 0006), so an optional field that has no value is left out rather than
 * set to `undefined`.
 *
 * Manifest syntax and the load checks are written down in `docs/manifest-v1.md`.
 * Validation lives in the loader (#03), not here.
 */

/** The manifest format version this tool understands (ADR 0006). */
export const FORMAT_VERSION = 1;

/** The rule for a step ID, an outcome name and an output name. */
export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * The shape of a `timeout` or `runTimeout` duration, such as `90s`, `30m`, `2h`.
 * It allows zero, which the loader rejects.
 */
export const DURATION_PATTERN = /^[0-9]+(?:\.[0-9]+)?[smh]$/;

/** Step IDs the manifest may not use. `input` holds the launch inputs. */
export const RESERVED_STEP_IDS = ["input"] as const;

/** A duration in milliseconds. */
export type Millis = number;

/** A harness name in the fixed adapter table (ADR 0004). */
export type HarnessName = "claude" | "pi";

/** A run's ID, made at launch, such as `2026-09-18-0001`. */
export type RunId = string;

/** An attempt's ID within its run, such as `007-fix`. */
export type AttemptId = string;

/** A step ID, matching `NAME_PATTERN`. */
export type StepId = string;

/** An outcome a step reports with `loopfile result <outcome>`, matching `NAME_PATTERN`. */
export type Outcome = string;

/** An output's short name, without its step ID, matching `NAME_PATTERN`. */
export type OutputName = string;

/** A launch input's name, read under `input.<name>`, matching `NAME_PATTERN`. */
export type InputName = string;

/** Where a run ends. */
export type EndState = "$success" | "$failure";

/** A transition target: a step ID or an end state. */
export type Target = StepId | EndState;

/** True when a target ends the run instead of naming the next step. */
export function isEndState(target: Target): target is EndState {
  return target === "$success" || target === "$failure";
}

/** Fields every step kind has. */
interface StepBase {
  readonly id: StepId;
  /**
   * Outcome to target. These keys are the step's only allowed outcomes; any
   * other outcome fails the attempt. Empty only on a command step, which then
   * goes to the next step in the list on a clean exit.
   */
  readonly on: Readonly<Record<Outcome, Target>>;
  /** Where a failed attempt goes. The loader fills in `$failure`. */
  readonly onFailure: Target;
  /**
   * Output name to the outcomes that require it. An empty array means the
   * output is required on every clean exit (the manifest's list form).
   */
  readonly outputs: Readonly<Record<OutputName, readonly Outcome[]>>;
  /** Visits to this step allowed in a run. The loader fills in 5. */
  readonly maxAttempts: number;
  /** Per attempt, or per iteration on a Ralph step. The loader fills in one hour. */
  readonly timeoutMs: Millis;
  /** Limits the manifest explicitly sets, kept so prompt data can distinguish defaults. */
  readonly declaredLimits?: { readonly maxAttempts?: number; readonly timeout?: string };
}

/** Fields an agent step and a Ralph step share. */
interface HarnessFields {
  readonly harness: HarnessName;
  /** Passed to the harness unchanged. Left out means the harness's own default. */
  readonly model?: string;
  /** In the harness's own words. Left out means the harness's own default. */
  readonly effort?: string;
  /** Given to the harness one string per argument, unchanged. The loader fills in `[]`. */
  readonly args: readonly string[];
  /**
   * Path to the prompt, relative to the materialized Loopfile. An inline
   * `prompt` is written to a run-owned file at materialization and named here,
   * so the model never holds prompt text.
   */
  readonly promptFile: string;
}

/** A step that calls a harness once. */
export interface AgentStep extends StepBase, HarnessFields {
  readonly kind: "agent";
}

/** A step that calls a harness repeatedly, each time with fresh context. */
export interface RalphStep extends StepBase, HarnessFields {
  readonly kind: "ralph";
  /** Iterations allowed in one attempt. The loader fills in 10. */
  readonly maxIterations: number;
}

/** A step that runs a shell command as `sh -e -c <run>`. */
export interface CommandStep extends StepBase {
  readonly kind: "command";
  readonly run: string;
}

export type Step = AgentStep | RalphStep | CommandStep;

/** One loaded Loopfile's workflow. */
export interface Workflow {
  readonly formatVersion: typeof FORMAT_VERSION;
  /**
   * Input name to its one-line description. Every declared input is required at
   * launch and is read under the data key `input.<name>`. Empty when the
   * workflow takes none.
   */
  readonly inputs: Readonly<Record<InputName, string>>;
  /** Transitions allowed in a run. Left out means no limit. */
  readonly maxTransitions?: number;
  /** Run owner time allowed for a run. Left out means no limit. */
  readonly runTimeoutMs?: Millis;
  /** The run timeout written in the manifest, kept so prompt data can distinguish an omission. */
  readonly declaredRunTimeout?: string;
  /** At least one step. The first is the entry step and the order is the fall-through path. */
  readonly steps: readonly Step[];
}
