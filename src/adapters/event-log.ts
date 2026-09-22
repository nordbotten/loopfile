/**
 * Appending to one run or loop's `events.jsonl` (ADR 0003).
 *
 * One JSON event on each line, one append-mode write followed by `fsync`, and
 * one writer: the run or loop owner. `seq` goes up by one across the whole
 * log, so a resumed owner continues the numbering rather than restarting it.
 * It is read once when the log is opened and counted in memory after that,
 * which the one-writer rule makes safe.
 */

import { open } from "node:fs/promises";
import { parseEventLog } from "../application/replay.ts";
import type { EventRecord, RunEvent, Timestamp } from "../domain/events.ts";

/**
 * An event as a caller writes it: the log fills in the envelope.
 *
 * The omit is written per event type rather than over the union, because
 * omitting from a union keeps only the fields every member shares — which
 * would let any event be appended with any other event's fields.
 */
export type NewEvent<Event extends EventRecord = RunEvent> = Event extends infer Record
  ? Record extends EventRecord
    ? Omit<Record, "seq" | "at"> & { readonly at?: Timestamp }
    : never
  : never;

/** The append path for one event-log kind. Nothing else opens the log for writing. */
export interface EventLog<Event extends EventRecord = RunEvent> {
  /** Appends one event and returns it as it was written, envelope and all. */
  append(event: NewEvent<Event>): Promise<Event>;
  close(): Promise<void>;
}

/**
 * Opens an event log for appending, continuing its numbering.
 *
 * A log that is not there yet is made: the owner writes its created event, so
 * the first append is also what creates the file.
 */
export async function openEventLog<Event extends EventRecord = RunEvent>(
  path: string,
): Promise<EventLog<Event>> {
  const file = await open(path, "a+");
  const events = parseEventLog<Event>(await file.readFile("utf8"));
  let seq = (events.at(-1)?.seq ?? 0) + 1;

  return {
    async append(event: NewEvent<Event>): Promise<Event> {
      const written = { ...event, seq, at: event.at ?? new Date().toISOString() } as Event;
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
