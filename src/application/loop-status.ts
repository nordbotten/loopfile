/** Folding a loop's append-only event log into its status projection. */

import type { LoopEndReason, LoopEvent, LoopSource } from "../domain/events.ts";
import {
  LOOP_STATUS_FORMAT_VERSION,
  type LoopLifecycle,
  type LoopStatus,
  type LoopStatusSource,
} from "../domain/status.ts";

/** Builds the loop status that a loop owner writes after its latest event. */
type MutableLoopStatus = { -readonly [Key in keyof LoopStatus]: LoopStatus[Key] };

export function loopStatus(events: readonly LoopEvent[]): LoopStatus {
  const created = events[0];
  if (created?.type !== "loop.created") {
    throw new Error("loop events.jsonl does not start with loop.created");
  }

  const status: MutableLoopStatus = {
    formatVersion: LOOP_STATUS_FORMAT_VERSION,
    seq: events.at(-1)?.seq ?? created.seq,
    loopId: created.loopId,
    loopfileName: created.loopfileName,
    state: "running",
    source: statusSource(created.source),
    place: created.source.kind === "next" ? null : 0,
    runs: 0,
    retries: 0,
    runIds: [],
    currentRunId: null,
    pausedUntil: null,
    cancelRequested: null,
    endReason: null,
    cancelMode: null,
    detail: null,
    startedAt: created.at,
    endedAt: null,
  };

  for (const event of events.slice(1)) applyEvent(status, event);
  return status;
}

function statusSource(source: LoopSource): LoopStatusSource {
  if (source.kind === "next") return source;
  return { kind: source.kind, count: source.kind === "list" ? source.sets.length : source.count };
}

function applyEvent(status: MutableLoopStatus, event: LoopEvent): void {
  switch (event.type) {
    case "loop.run_started":
      runStarted(status, event);
      return;
    case "loop.paused":
      status.pausedUntil = event.until;
      return;
    case "loop.cancel_requested":
      status.cancelRequested = event.mode;
      return;
    case "loop.ended":
      loopEnded(status, event);
      return;
    default:
      return;
  }
}

function runStarted(
  status: MutableLoopStatus,
  event: Extract<LoopEvent, { readonly type: "loop.run_started" }>,
): void {
  status.runs += 1;
  if (event.retryOf !== null) status.retries += 1;
  status.runIds = [...status.runIds, event.runId];
  status.currentRunId = event.runId;
  status.pausedUntil = null;
  if (status.place !== null && event.sourceIndex !== null) {
    status.place = Math.max(status.place, event.sourceIndex);
  }
}

function loopEnded(
  status: MutableLoopStatus,
  event: Extract<LoopEvent, { readonly type: "loop.ended" }>,
): void {
  status.state = stateFor(event.reason);
  status.endReason = event.reason;
  status.cancelMode = event.reason === "cancelled" ? event.cancelMode : null;
  status.detail = event.detail ?? null;
  status.currentRunId = null;
  status.pausedUntil = null;
  status.endedAt = event.at;
}

function stateFor(reason: LoopEndReason): LoopLifecycle {
  if (reason === "source_empty" || reason === "max_runs") return "completed";
  if (reason === "cancelled") return "cancelled";
  return "failed";
}
