/**
 * The run owner's side of `result <outcome> [--message <text>]` (#26): turns
 * an accepted attempt call into an `outcome.reported` event.
 *
 * Wiring this in as a running attempt's `serveAttempt` handler, alongside
 * whatever #19 and #20 answer, and passing it the step's own `on` keys as
 * `allowedOutcomes`, is #116's to do. This only builds the one handler
 * `result` needs, so it can be served and tested on its own.
 */

import { checkResult, outcomeReportedFields, readMessageFlag } from "../application/result.ts";
import type { RunEvent } from "../domain/events.ts";
import type { Outcome } from "../domain/model.ts";
import type { EventLog } from "./event-log.ts";
import type { AttemptCallHandler } from "./run-owner.ts";

export interface ResultHandlerOptions {
  readonly events: EventLog;
  /** The running step's `on` keys. Empty means the step has none, so every call is refused. */
  readonly allowedOutcomes: readonly Outcome[];
  /** The run's events so far. Read fresh for each call, so an earlier report is seen. */
  history(): readonly RunEvent[];
}

/** Answers a `result` call. Any other call is not this handler's to answer. */
export function resultHandler(options: ResultHandlerOptions): AttemptCallHandler {
  return (call) => {
    if (call.argv[0] !== "result") {
      return { ok: false, code: "unbuilt", message: `\`${call.argv.join(" ")}\` is not built yet` };
    }
    const outcome = call.argv[1];
    if (outcome === undefined || outcome === "") {
      return { ok: false, code: "missing_arg", message: "result needs an outcome" };
    }

    const check = checkResult(
      options.history(),
      call.attemptId,
      call.iteration,
      outcome,
      options.allowedOutcomes,
    );
    if (!check.ok) {
      return { ok: false, code: "bad_outcome", message: check.reason, allowed: check.allowed };
    }

    const fields = outcomeReportedFields(
      call.attemptId,
      call.iteration,
      outcome,
      readMessageFlag(call.argv),
    );
    return options.events
      .append({ type: "outcome.reported", ...fields })
      .then(() => ({ ok: true }));
  };
}
