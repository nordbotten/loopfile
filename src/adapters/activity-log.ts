/**
 * Appending to a run's `activity.log` (#50, ADR 0007).
 *
 * Plain text, one line per message, append-only, and only the run owner
 * writes it. Every write is its own open-append-close, so each line lands as
 * one complete write: what makes `tail -f` show whole lines while the run is
 * active. `activity.log` is derived, never read back by anything in this
 * process (ADR 0007), so unlike `event-log.ts` there is no in-memory state to
 * keep open across calls.
 *
 * `appendActivity` is the one function both a lifecycle line (`withActivityHook`
 * below) and a harness line (#25a) go through, so the filter in
 * `application/activity.ts` runs over every line the same way.
 */

import { appendFile } from "node:fs/promises";
import {
  type ActivityLine,
  type ActivitySecrets,
  activityLineForEvent,
  filterActivityText,
  formatActivityLine,
} from "../application/activity.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId } from "../domain/model.ts";
import type { EventLog } from "./event-log.ts";

/**
 * Filters `text` and appends it to `path` as one line, timestamped now.
 *
 * A write that fails is the caller's to decide about: the activity log is a
 * convenience for an observer, not run state, so losing a line is never a
 * reason to fail the run.
 */
export async function appendActivity(
  path: string,
  attemptId: AttemptId | null,
  text: string,
  secrets: ActivitySecrets = {},
): Promise<void> {
  const line = formatActivityLine(new Date(), attemptId, filterActivityText(text, secrets));
  await appendFile(path, `${line}\n`);
}

/**
 * Wraps `events` so every appended event that `activityLineForEvent` names
 * also gets its lifecycle line in `activity.log` — the run owner's event
 * appender is the one place every lifecycle event passes through, so hooking
 * it here catches attempt start and end, the route, the outcome and every
 * data command without a separate call at each of their call sites.
 *
 * A failed activity write is logged and swallowed rather than thrown: it
 * would otherwise fail the event append it rode in on, and the event log is
 * the source of truth (ADR 0003), the activity log is not.
 */
export function withActivityHook(events: EventLog, activityPath: string): EventLog {
  return {
    async append(event) {
      const written = await events.append(event);
      await writeLifecycleLine(activityPath, written);
      return written;
    },
    close: () => events.close(),
  };
}

async function writeLifecycleLine(activityPath: string, event: RunEvent): Promise<void> {
  const line: ActivityLine | null = activityLineForEvent(event);
  if (line === null) return;
  await appendActivity(activityPath, line.attemptId, line.text).catch((error: unknown) => {
    console.error(`activity.log: could not append (${String(error)})`);
  });
}
