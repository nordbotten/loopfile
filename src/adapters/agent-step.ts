/**
 * Starts an agent step: one harness call per attempt (#25, ADR 0004).
 *
 * The step's `harness` field picks the adapter from the fixed table, so there
 * is no harness-specific branch here. The run owner reads the prompt file and
 * hands the text to the adapter; the agent never gets the file path. The
 * outcome is not read from harness output: it is the `outcome.reported` event
 * the `result` command left, read after the process ended.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type AgentEnd, classifyAgentEnd, reportedOutcome } from "../application/agent-step.ts";
import type {
  ExecutionContext,
  Executor,
  RunningProcess,
  StartFailure,
} from "../application/executor.ts";
import type { HarnessActivity, HarnessAdapters } from "../application/harness.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AgentStep, Step } from "../domain/model.ts";
import type { AttemptPaths } from "./attempt-directory.ts";
import { startHarnessCall } from "./harness-call.ts";
import {
  fillEffortForCall,
  fillFieldForCall,
  fillPromptForCall,
  type PromptFillOptions,
} from "./prompt-fill.ts";

export type AgentStepStart =
  | (StartFailure & { readonly reason: "start_failed" })
  | {
      readonly kind: "bad-field";
      readonly field: "model" | "effort";
      readonly value?: string;
    }
  | (Pick<RunningProcess, "kind" | "processGroupId" | "cancel"> & {
      /** Settles after the process ended and its output files are written. */
      readonly ended: Promise<AgentEnd>;
    });

export interface AgentStepOptions extends PromptFillOptions {
  readonly executor: Executor;
  readonly adapters: HarnessAdapters;
  /** The materialized Loopfile's root. `promptFile` is relative to it. */
  readonly loopfileRoot: string;
  /** The run's events so far. Read after the process ended, to find the outcome. */
  history(): readonly RunEvent[];
  onActivity(activity: HarnessActivity): void;
}

export async function startAgentStep(
  options: AgentStepOptions,
  step: AgentStep,
  context: ExecutionContext,
  attempt: Pick<AttemptPaths, "stdout" | "stderr" | "wiring">,
  startedAt = new Date().toISOString(),
  steps?: readonly Step[],
): Promise<AgentStepStart> {
  if (isAbsolute(step.promptFile)) {
    throw new Error(`promptFile is not relative to the Loopfile: ${step.promptFile}`);
  }
  const model = step.model === undefined ? undefined : await fillFieldForCall(options, step.model);
  if (step.model !== undefined && model === undefined) return { kind: "bad-field", field: "model" };
  const effort = await fillEffortForCall(options, step);
  if ("field" in effort) return { kind: "bad-field", ...effort };
  const prompt = await fillPromptForCall(
    options,
    { attemptId: context.attemptId, stepId: context.stepId, startedAt, step, steps },
    await readFile(join(options.loopfileRoot, step.promptFile), "utf8"),
  );
  const started = await startHarnessCall(
    options.executor,
    options.adapters[step.harness],
    {
      context,
      prompt,
      ...(model === undefined ? {} : { model }),
      ...effort.fields,
      args: step.args,
      wiringFolder: attempt.wiring,
    },
    attempt,
    options.onActivity,
  );
  if ("reason" in started) return started;
  return {
    kind: "running",
    processGroupId: started.processGroupId,
    cancel: () => started.cancel(),
    ended: started.ended.then((exit) =>
      classifyAgentEnd(step, exit, reportedOutcome(options.history(), context.attemptId)),
    ),
  };
}
