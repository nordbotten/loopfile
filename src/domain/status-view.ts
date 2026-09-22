/**
 * The v1 `status <runid> --json` shape (#36, ADR 0006, ADR 0007).
 *
 * It is `status.json` with two changes: `state` holds the derived state
 * (`crashed` and `unknown` included, which `status.json` never does, ADR
 * 0008), and `recentTransitions` adds what `events.jsonl` knows about the
 * last few moves. Metrics stay `null` when unknown; nothing is made up.
 */

import type { Timestamp, TransitionCause } from "./events.ts";
import type { Outcome, StepId, Target } from "./model.ts";
import type { RunListState } from "./run-list.ts";
import type { StatusProjection } from "./status.ts";

/** One transition, as `events.jsonl` recorded it. */
export interface RecentTransition {
  readonly at: Timestamp;
  readonly from: StepId;
  readonly to: Target;
  readonly cause: TransitionCause;
  /** `null` when the transition carried no outcome. */
  readonly outcome: Outcome | null;
}

/** `status <runid> --json`'s whole output. Its `formatVersion` is the status format's. */
export interface RunStatusView extends Omit<StatusProjection, "state"> {
  readonly state: RunListState;
  /** Oldest first. */
  readonly recentTransitions: readonly RecentTransition[];
}
