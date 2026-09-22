/**
 * A command step: normal runtime code that runs one shell line through the
 * executor (ADR 0004, #71). It is not an executor.
 *
 * The whole `run` string is one argument to `sh -e -c`, so a multi-line `run`
 * stops at its first failing line, and pipes and `&&` work as in any shell.
 * The step reports an outcome, if it has one, with the same result command an
 * agent uses (ADR 0005). Without one, how the process ended is all there is.
 */

import type { AttemptEndReason } from "../domain/events.ts";
import type { CommandStep } from "../domain/model.ts";
import type { Ended, ExecutionContext, StartRequest } from "./executor.ts";

/** What a command step asks the executor to start. */
export function commandStepRequest(step: CommandStep, context: ExecutionContext): StartRequest {
  return { command: "sh", args: ["-e", "-c", step.run], context };
}

/**
 * How a started command step's process ended, as routing reads it: only exit
 * code 0 is clean. A start that failed is `start_failed`, never an exit.
 */
export function commandEndReason(
  end: Ended,
): Extract<AttemptEndReason, "clean_exit" | "nonzero_exit"> {
  return end.kind === "exited" && end.code === 0 ? "clean_exit" : "nonzero_exit";
}
