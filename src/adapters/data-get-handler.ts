/**
 * The run owner's side of `data get <key>` (#19): turns an accepted attempt
 * call into a data store read and the wire reply `src/application/data-get.ts`
 * decodes.
 *
 * Wiring this in as a running attempt's `serveAttempt` handler, alongside
 * whatever #20 and #26 answer, is #116's to do. This only builds the one
 * handler `data get` needs, so it can be served and tested on its own.
 */

import { sourceOfGet } from "../application/data-store.ts";
import type { RunEvent } from "../domain/events.ts";
import { DataStoreError, get } from "./data-store.ts";
import type { EventLog } from "./event-log.ts";
import type { AttemptCallHandler } from "./run-owner.ts";

export interface DataGetHandlerOptions {
  readonly events: EventLog;
  readonly attemptsFolder: string;
  /** `RunPaths.inputs`: where the run's launch inputs sit (#82). */
  readonly inputsFolder: string;
  /** The run's events so far. Read fresh for each call, so a later put is seen. */
  history(): readonly RunEvent[];
}

/** Answers a `data get` call. Any other call is not this handler's to answer. */
export function dataGetHandler(options: DataGetHandlerOptions): AttemptCallHandler {
  return async (call) => {
    if (call.argv[0] !== "data" || call.argv[1] !== "get") {
      return { ok: false, code: "unbuilt", message: `\`${call.argv.join(" ")}\` is not built yet` };
    }
    const key = call.argv[2];
    if (key === undefined || key === "") {
      return { ok: false, code: "missing_arg", message: "data get needs a key" };
    }

    const history = options.history();
    // Read before the store's own lookup, purely to name the putting attempt
    // on the wire (#84): a second, pure pass over the same events, not a
    // second source of truth for what the value is.
    const source = sourceOfGet(history, key);
    try {
      const result = await get({
        events: options.events,
        history,
        attemptsFolder: options.attemptsFolder,
        inputsFolder: options.inputsFolder,
        attemptId: call.attemptId,
        key,
      });
      return {
        ok: true,
        ...(source?.kind === "attempt" ? { attemptId: source.attemptId } : {}),
        size: result.content.byteLength,
        content: result.content.toString("base64"),
      };
    } catch (error) {
      if (error instanceof DataStoreError) {
        return { ok: false, code: "unknown_key", message: error.message };
      }
      throw error;
    }
  };
}
