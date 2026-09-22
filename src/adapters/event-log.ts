/**
 * Appending to a run's `events.jsonl` (ADR 0003).
 *
 * One JSON event on each line, one append-mode write followed by `fsync`, and
 * one writer: the run owner. Readers get their picture from `replay`, which
 * only ever reads this file.
 *
 * `seq` goes up by one across the whole run, so a run owner that takes over a
 * resumed run continues the numbering rather than restarting it. It is read
 * once when the log is opened and counted in memory after that, which the
 * one-writer rule makes safe.
 */

import { open } from "node:fs/promises";
import { parseEventLog } from "../application/replay.ts";
import type { RunEvent, Timestamp } from "../domain/events.ts";

/**
 * An event as a caller writes it: the log fills in the envelope.
 *
 * The omit is written per event type rather than over the union, because
 * omitting from a union keeps only the fields every member shares — which
 * would let any event be appended with any other event's fields.
 */
export type NewEvent = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "seq" | "at"> & { readonly at?: Timestamp }
    : never
  : never;

/** The run owner's append path. Nothing else opens the log for writing. */
export interface EventLog {
  /** Appends one event and returns it as it was written, envelope and all. */
  append(event: NewEvent): Promise<RunEvent>;
  close(): Promise<void>;
}

/**
 * Opens a run's event log for appending, continuing its numbering.
 *
 * A log that is not there yet is made: the run owner writes `run.created`, so
 * the first append is also what creates the file.
 */
export async function openEventLog(path: string): Promise<EventLog> {
  const file = await open(path, "a+");
  const events = parseEventLog(await file.readFile("utf8"));
  let seq = (events.at(-1)?.seq ?? 0) + 1;

  return {
    async append(event: NewEvent): Promise<RunEvent> {
      const written = { ...event, seq, at: event.at ?? new Date().toISOString() } as RunEvent;
      await file.appendFile(`${JSON.stringify(written)}\n`);
      await file.sync();
      seq += 1;
      return written;
    },
    async close(): Promise<void> {
      await file.close();
    },
  };
}
