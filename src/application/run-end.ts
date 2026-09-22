/**
 * How a run ended, and what a script reads from it (#184, #185).
 *
 * Pure. One shape, `RunEnd`, and one mapping from it to an exit code, a
 * stdout line and the stderr help text. Every command that waits for a run
 * ends here: the monitor and `loopfile <source>` build a `RunEnd` from
 * `status.json`, `tail` builds one from the end event line it was already
 * watching for. Two readers, one contract, so the codes and the wording
 * cannot drift apart.
 */

import type { RunEndReason } from "../domain/events.ts";
import type { RunLifecycle, StatusEndReason, StatusProjection } from "../domain/status.ts";
import type { RunResult } from "./replay.ts";
import { lifecycleOf } from "./status-projection.ts";

/** How a run ended, from whichever of the two sources the reader had. */
export interface RunEnd {
  readonly runId: string;
  readonly state: RunLifecycle;
  readonly endReason: StatusEndReason | null;
  /** The step the run ended at, when one is known. */
  readonly stepId: string | null;
}

/** The exit code for a run that ended: 0 when it completed, 1 when it failed or was cancelled. */
export function endedExitCode(end: Pick<RunEnd, "state">): number {
  return end.state === "completed" ? 0 : 1;
}

/** The stdout line a script reads when the run ends: `<runid> <state>`. */
export function endedLine(end: Pick<RunEnd, "runId" | "state">): string {
  return `${end.runId} ${end.state}\n`;
}

/** For stderr: why a run did not complete and where to look. Empty for a completed run. */
export function endedHelp(end: RunEnd): string {
  if (end.state === "completed") return "";
  const step = end.stepId === null ? "" : ` at step "${end.stepId}"`;
  return (
    `run ${end.runId} ${end.state}: ${end.endReason ?? "unknown"}${step}\n` +
    `  see: loopfile logs ${end.runId}\n` +
    `       loopfile status ${end.runId} --json\n`
  );
}

/**
 * The end `status.json` reports. The step is the one the run last left: a
 * projection carries no end step of its own, and the last transition's `from`
 * is the step the run was at when it stopped.
 */
export function runEndFromStatus(status: StatusProjection): RunEnd {
  return {
    runId: status.runId,
    state: status.state,
    endReason: status.endReason,
    stepId: status.lastTransition === null ? null : status.lastTransition.from,
  };
}

/**
 * The end a `run.ended` or `run.cancelled` event reports.
 *
 * The state and reason come from `lifecycleOf`, the same mapping
 * `status.json` is built with, so the two sources cannot disagree about what
 * a result means. Only the step is read off the event itself: `run.ended`
 * names the step that hit its limit, which a projection can only guess at
 * from its last transition.
 */
export function runEndFromEvent(runId: string, event: EndEvent): RunEnd {
  const result: RunResult =
    event.type === "run.cancelled"
      ? { result: "cancelled" }
      : { result: event.result, reason: event.reason };
  const { state, endReason } = lifecycleOf(result);
  return {
    runId,
    state,
    endReason,
    stepId: (event.type === "run.ended" ? event.stepId : undefined) ?? null,
  };
}

/** A `run.ended` or `run.cancelled` event, down to the fields the end is read from. */
export type EndEvent =
  | { readonly type: "run.cancelled" }
  | {
      readonly type: "run.ended";
      readonly result: "success" | "failure";
      readonly reason: RunEndReason;
      readonly stepId?: string;
    };
