/**
 * The harness adapter interface (ADR 0004, ADR 0005, ADR 0007).
 *
 * It is internal, not a plugin API. An adapter only describes one harness
 * call and reads its output. The runtime starts the process through the
 * executor, keeps the raw output and owns cancel and timeouts, so an adapter
 * cannot start a process or decide anything: it gets no way to.
 *
 * An adapter sends activity text as the harness gives it. The runtime filters
 * every line (`filterActivityText`), so there is no second filter here.
 */

import type { HarnessName } from "../domain/model.ts";
import type { StatusMetrics } from "../domain/status.ts";
import type { ExecutionContext } from "./executor.ts";

/** One harness call: an agent attempt, or one iteration of a Ralph attempt. */
export interface HarnessCall {
  /** This call's context. A Ralph iteration gets a new secret (ADR 0005). */
  readonly context: ExecutionContext;
  /** The prompt text after the run owner filled its placeholders (#96). */
  readonly prompt: string;
  readonly model?: string;
  /** Already checked by the loader. */
  readonly effort?: string;
  /** Passed to the harness unchanged. */
  readonly args: readonly string[];
  /** The attempt `wiring/` folder, or the iteration `wiring/` folder on a Ralph step. */
  readonly wiringFolder: string;
}

export interface PreparedHarnessCall {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to the harness stdin, then stdin is closed. */
  readonly stdin?: string;
  /** File name (no `/`, no `..`) to content. Written into `wiringFolder` before the start. */
  readonly wiringFiles: Readonly<Record<string, string>>;
  /** Called once for each complete stdout line of this call, in order. */
  parseStdoutLine(line: string): readonly HarnessActivity[];
}

export type HarnessActivity =
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly target: string;
      /** The harness reported that this call was denied. */
      readonly denied?: boolean;
    }
  | { readonly kind: "progress"; readonly text: string }
  /** Totals for one call. The activity reducer adds this report to the current attempt sum. `null` means unknown. */
  | { readonly kind: "metrics"; readonly metrics: StatusMetrics };

export interface HarnessAdapter {
  prepare(call: HarnessCall): PreparedHarnessCall;
}

/** What the runtime takes. Tests give one with the fake behind a real name. */
export type HarnessAdapters = Readonly<Record<HarnessName, HarnessAdapter>>;
