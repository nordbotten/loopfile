/**
 * What one harness update does to a run's live data and activity log (#25a,
 * ADR 0003, ADR 0007).
 *
 * Pure: an update and the harness data so far go in; the next harness data
 * and the log line (if any) come out. Tool calls and progress text become
 * `activity.log` lines; metrics only ever land in `status.json`. A metrics
 * report adds its one-call totals to the five usage fields so far. No update
 * is an event. Every update sets the last activity time.
 */

import type { Timestamp } from "../domain/events.ts";
import { type ActivitySecrets, filterActivityText } from "./activity.ts";
import type { HarnessActivity } from "./harness.ts";
import { addMetrics, type HarnessData } from "./status-projection.ts";

export interface HarnessActivityResult {
  readonly data: HarnessData;
  /** Unfiltered text for `activity.log`, or `null` for a metrics update. */
  readonly logText: string | null;
}

export function applyHarnessActivity(
  data: HarnessData,
  activity: HarnessActivity,
  at: Timestamp,
  secrets: ActivitySecrets = {},
): HarnessActivityResult {
  switch (activity.kind) {
    case "tool":
      return {
        data: { ...data, lastActivityAt: at },
        logText: `${activity.tool} ${activity.target}${activity.denied ? " (denied)" : ""}`.trim(),
      };
    case "progress":
      return {
        data: {
          ...data,
          lastActivityAt: at,
          lastProgress: filterActivityText(activity.text, secrets),
        },
        logText: activity.text,
      };
    case "metrics":
      return {
        data: { ...data, lastActivityAt: at, metrics: addMetrics(data.metrics, activity.metrics) },
        logText: null,
      };
  }
}
