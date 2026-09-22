/**
 * Starts a command step through an executor and keeps its raw output in the
 * attempt folder (#12, #15).
 *
 * What the request is and what an end means are pure rules in
 * `application/command-step.ts`. This file starts the process and writes its
 * output files.
 */

import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { commandEndReason, commandStepRequest } from "../application/command-step.ts";
import type {
  Ended,
  ExecutionContext,
  Executor,
  RunningProcess,
  StartFailure,
} from "../application/executor.ts";
import type { CommandStep } from "../domain/model.ts";
import type { AttemptPaths } from "./attempt-directory.ts";

/** How a started command step ended, once its output files are complete. */
export interface CommandStepEnd {
  readonly reason: "clean_exit" | "nonzero_exit";
  readonly ended: Ended;
}

/**
 * A running command step, or the reason it never started. A failed start
 * writes no output files, because no process ever wrote anything.
 */
export type CommandStepStart =
  | (StartFailure & { readonly reason: "start_failed" })
  | (Pick<RunningProcess, "kind" | "processGroupId" | "cancel"> & {
      /** Settles after the process ended and both output files are written. */
      readonly ended: Promise<CommandStepEnd>;
    });

export async function startCommandStep(
  executor: Executor,
  step: CommandStep,
  context: ExecutionContext,
  attempt: Pick<AttemptPaths, "stdout" | "stderr">,
): Promise<CommandStepStart> {
  const started = await executor.start(commandStepRequest(step, context));
  if (started.kind === "start-failed") return { ...started, reason: "start_failed" };

  const ended = Promise.all([
    started.ended,
    pipeline(started.stdout, createWriteStream(attempt.stdout)),
    pipeline(started.stderr, createWriteStream(attempt.stderr)),
  ]).then(([end]) => ({ reason: commandEndReason(end), ended: end }));

  return {
    kind: "running",
    processGroupId: started.processGroupId,
    cancel: () => started.cancel(),
    ended,
  };
}
