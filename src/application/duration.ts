/** Parses the duration syntax shared by workflow timeouts and loop pauses. */

import { DURATION_PATTERN, type Millis } from "../domain/model.ts";

const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000 };

export function durationMillis(text: string): Millis | undefined {
  if (!DURATION_PATTERN.test(text)) return undefined;
  const ms = Math.round(Number.parseFloat(text) * (UNIT_MS[text.slice(-1)] as number));
  return ms > 0 ? ms : undefined;
}
