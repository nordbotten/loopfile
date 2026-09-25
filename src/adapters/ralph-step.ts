/**
 * Runs a Ralph step's attempt as repeated harness calls (#33, ADR 0005).
 *
 * Each iteration is one call through the adapter with fresh agent context, a
 * new attempt secret and its own output folder. The workspace and the data
 * puts stay between iterations. The rules are in `application/ralph-step.ts`;
 * this file starts the calls, holds the per-iteration timer and records events.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Ended, ExecutionContext, Executor, StartFailure } from "../application/executor.ts";
import type { HarnessActivity, HarnessAdapters } from "../application/harness.ts";
import { checkOutputs } from "../application/output-check.ts";
import type { AttemptIdentity } from "../application/owner-protocol.ts";
import {
  classifyIteration,
  ITERATION_LIMIT_END,
  iterationOutcome,
  outcomeEnd,
  type RalphAttemptEnd,
} from "../application/ralph-step.ts";
import type { RunEvent } from "../domain/events.ts";
import type { RalphStep, Step } from "../domain/model.ts";
import { type AttemptPaths, createIterationDirectory } from "./attempt-directory.ts";
import type { EventLog } from "./event-log.ts";
import { startHarnessCall } from "./harness-call.ts";
import {
  callFieldsForCall,
  fillEffortForCall,
  fillFieldForCall,
  fillPromptForCall,
  type PromptFillOptions,
} from "./prompt-fill.ts";

export interface RalphStepOptions extends Omit<PromptFillOptions, "events"> {
  readonly executor: Executor;
  readonly adapters: HarnessAdapters;
  /** The materialized Loopfile's root. `promptFile` is relative to it. */
  readonly loopfileRoot: string;
  readonly events: Pick<EventLog, "append">;
  /** The run's events so far, including those `events` appended. */
  history(): readonly RunEvent[];
  onActivity(activity: HarnessActivity): void;
  /** A new random attempt secret. Called once per iteration. */
  newSecret(): string;
  /** Stops this attempt before Ralph starts another iteration. */
  readonly stopSignal?: AbortSignal;
  /**
   * The identity the run owner answers now: set when an iteration starts and
   * cleared when it ends, so a call from an ended iteration is refused.
   */
  setCurrent(identity: AttemptIdentity | undefined): void;
}

export type RalphStepEnd = RalphAttemptEnd & {
  /** Iterations that started in this attempt. */
  readonly iterations: number;
};

/** How the attempt ended, or the failed start of an iteration's process. */
export type RalphStepResult =
  | (StartFailure & { readonly reason: "start_failed"; readonly iterations: number })
  | RalphStepEnd;

export async function runRalphStep(
  options: RalphStepOptions,
  step: RalphStep,
  context: ExecutionContext,
  attempt: AttemptPaths,
  startedAt = new Date().toISOString(),
  steps?: readonly Step[],
): Promise<RalphStepResult> {
  if (isAbsolute(step.promptFile)) {
    throw new Error(`promptFile is not relative to the Loopfile: ${step.promptFile}`);
  }
  const template = await readFile(join(options.loopfileRoot, step.promptFile), "utf8");
  const adapter = options.adapters[step.harness];

  for (let iteration = 1; iteration <= step.maxIterations; iteration++) {
    const result = await runRalphIteration(
      options,
      step,
      context,
      attempt,
      startedAt,
      steps,
      template,
      adapter,
      iteration,
    );
    if (result !== undefined) return result;
  }
  return { ...ITERATION_LIMIT_END, iterations: step.maxIterations };
}

async function runRalphIteration(
  options: RalphStepOptions,
  step: RalphStep,
  context: ExecutionContext,
  attempt: AttemptPaths,
  startedAt: string,
  steps: readonly Step[] | undefined,
  template: string,
  adapter: HarnessAdapters[typeof step.harness],
  iteration: number,
): Promise<RalphStepResult | undefined> {
  const { attemptId } = context;
  if (options.stopSignal?.aborted) {
    return {
      kind: "start-failed",
      message: "the attempt was interrupted",
      reason: "start_failed",
      iterations: iteration,
    };
  }
  const model = step.model === undefined ? undefined : await fillFieldForCall(options, step.model);
  if (step.model !== undefined && model === undefined) {
    return { result: "failure", reason: "bad_field", field: "model", iterations: iteration - 1 };
  }
  const effort = await fillEffortForCall(options, step);
  if ("field" in effort) {
    return { result: "failure", reason: "bad_field", ...effort, iterations: iteration - 1 };
  }
  const fields = callFieldsForCall(step.harness, model, effort.fields);
  const paths = await createIterationDirectory(attempt, iteration);
  const secret = options.newSecret();
  const prompt = await fillPromptForCall(
    options,
    { attemptId, stepId: step.id, startedAt, step, steps, iteration, fields },
    template,
  );
  const started = await startHarnessCall(
    options.executor,
    adapter,
    {
      context: { ...context, attemptSecret: secret, iteration },
      prompt,
      ...(model === undefined ? {} : { model }),
      ...effort.fields,
      args: step.args,
      wiringFolder: paths.wiring,
    },
    paths,
    options.onActivity,
  );
  if ("reason" in started) return { ...started, iterations: iteration };

  options.setCurrent({ attemptId, secret, iteration });
  await options.events.append({
    type: "iteration.started",
    attemptId,
    iteration,
    processGroupId: started.processGroupId,
    fields,
  });
  const { exit, timedOut } = await waitForIteration(options.stopSignal, step.timeoutMs, started);
  options.setCurrent(undefined);

  const outcome = iterationOutcome(options.history(), attemptId, iteration);
  const reason = classifyIteration(exit, timedOut, outcome);
  await options.events.append({ type: "iteration.ended", attemptId, iteration, reason });

  if (reason === "outcome" && outcome !== undefined) {
    return { ...checkedEnd(options, step, attemptId, outcome), iterations: iteration };
  }
  return undefined;
}

async function waitForIteration(
  stopSignal: AbortSignal | undefined,
  timeoutMs: number,
  started: { readonly ended: Promise<Ended>; cancel(): void },
): Promise<{ readonly exit: Ended; readonly timedOut: boolean }> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    started.cancel();
  }, timeoutMs);
  const stop = () => started.cancel();
  stopSignal?.addEventListener("abort", stop, { once: true });
  if (stopSignal?.aborted) stop();
  const exit = await started.ended;
  clearTimeout(timer);
  stopSignal?.removeEventListener("abort", stop);
  return { exit, timedOut };
}

/** The outcome's end, unless a required output was never put by any iteration. */
function checkedEnd(
  options: RalphStepOptions,
  step: RalphStep,
  attemptId: string,
  outcome: string,
): RalphAttemptEnd {
  const end = outcomeEnd(step, outcome);
  if (end.result === "failure") return end;
  const check = checkOutputs(step, options.history(), attemptId, outcome);
  return check.allowed ? end : { result: "failure", reason: "missing_output", outcome };
}
