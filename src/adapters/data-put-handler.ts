/**
 * The run owner's side of `data put <key> <file>` and `data append <key>
 * <value>` (#20): turns an accepted attempt call into a data store write and
 * the wire reply `src/application/data-put.ts` decodes.
 *
 * The content rides the request as a base64 argument, the same way a `data
 * get` reply carries its content: one JSON line, no second transport. The CLI
 * (EXEMPT) reads the source file or stdin and encodes it before the call ever
 * reaches this handler.
 *
 * Wiring this in as a running attempt's `serveAttempt` handler, alongside
 * whatever #19 and #26 answer, is #116's to do. This only builds the one
 * handler `data put`/`data append` needs, so it can be served and tested on
 * its own.
 */

import { sha256 } from "../application/data-store.ts";
import type { RunEvent } from "../domain/events.ts";
import { DataStoreError, put } from "./data-store.ts";
import type { EventLog } from "./event-log.ts";
import type { AttemptCallHandler } from "./run-owner.ts";

export interface DataPutHandlerOptions {
  readonly events: EventLog;
  readonly attemptsFolder: string;
  /** The run's events so far. Read fresh for each call, so an earlier write is seen. */
  history(): readonly RunEvent[];
}

/** Answers a `data put` or `data append` call. Any other call is not this handler's to answer. */
export function dataPutHandler(options: DataPutHandlerOptions): AttemptCallHandler {
  return async (call) => {
    const verb = call.argv[1];
    if (call.argv[0] !== "data" || (verb !== "put" && verb !== "append")) {
      return { ok: false, code: "unbuilt", message: `\`${call.argv.join(" ")}\` is not built yet` };
    }
    const key = call.argv[2];
    const encoded = call.argv[3];
    if (key === undefined || key === "" || encoded === undefined) {
      return { ok: false, code: "missing_arg", message: `data ${verb} needs a key and a value` };
    }

    const content = Buffer.from(encoded, "base64");
    try {
      await put({
        events: options.events,
        history: options.history(),
        attemptsFolder: options.attemptsFolder,
        attemptId: call.attemptId,
        key,
        content,
        appended: verb === "append",
      });
      return { ok: true, size: content.byteLength, digest: sha256(content) };
    } catch (error) {
      if (error instanceof DataStoreError) {
        return { ok: false, code: error.kind ?? "stale_attempt", message: error.message };
      }
      throw error;
    }
  };
}
