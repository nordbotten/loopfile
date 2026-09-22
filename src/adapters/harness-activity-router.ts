/**
 * Routes harness updates for one run (#25a, ADR 0003, ADR 0007).
 *
 * Tool calls and progress text go to `activity.log`, filtered. Metrics and the
 * last activity time go to `status.json` through the status writer. Nothing
 * here touches the event log, so no update is ever an event.
 *
 * Give the returned function to `startAgentStep` as `onActivity`.
 */

import type { ActivitySecrets } from "../application/activity.ts";
import type { HarnessActivity } from "../application/harness.ts";
import { applyHarnessActivity } from "../application/harness-activity.ts";
import { type HarnessData, NO_HARNESS_DATA } from "../application/status-projection.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId } from "../domain/model.ts";
import { appendActivity } from "./activity-log.ts";
import type { StatusWriter } from "./status-writer.ts";

export interface HarnessActivityRouterOptions {
  readonly activityPath: string;
  readonly attemptId: AttemptId;
  readonly secrets: ActivitySecrets;
  readonly status: StatusWriter;
  /** The run's events so far. */
  events(): readonly RunEvent[];
  /** The latest data is needed by the attempt.ended event. */
  readonly onData?: (data: HarnessData) => void;
  /** Current attempt data, carried into the next Ralph iteration. */
  readonly initialData?: HarnessData;
  /** Overridable for tests only. */
  readonly now?: () => Date;
}

export function harnessActivityRouter(
  options: HarnessActivityRouterOptions,
): (activity: HarnessActivity) => void {
  const now = options.now ?? (() => new Date());
  let data = options.initialData ?? NO_HARNESS_DATA;
  return (activity) => {
    const result = applyHarnessActivity(data, activity, now().toISOString(), options.secrets);
    data = result.data;
    options.onData?.(data);
    options.status.onHarnessUpdate(options.events(), data);
    if (result.logText === null) return;
    // Losing a line never fails a call: the log is derived, not run state.
    appendActivity(options.activityPath, options.attemptId, result.logText, options.secrets).catch(
      (error: unknown) => {
        console.error(`activity.log: could not append (${String(error)})`);
      },
    );
  };
}
