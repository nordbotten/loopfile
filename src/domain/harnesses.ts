/**
 * The fixed harness table: what the loader may know about a harness without
 * importing its adapter (ADR 0004). `docs/manifest-v1.md` is the user-facing
 * copy of the effort lists.
 */

import type { HarnessName } from "./model.ts";

export interface HarnessSpec {
  /** Allowed `effort` words, in the harness's own words. */
  readonly effort: readonly string[];
  /** Flags the adapter sets. The loader rejects them in `args` (#132). */
  readonly ownedFlags: readonly string[];
}

export const HARNESSES: Readonly<Record<HarnessName, HarnessSpec>> = {
  claude: {
    effort: ["low", "medium", "high", "max"],
    /*
     * `--input-format` is owned: `stream-json` input would break the prompt on
     * stdin. `--settings` is not: tested with claude 2.1.276, 2 `--settings`
     * flags do not merge and only the last one is used. So the adapter's comes
     * last, and the adapter merges a user's `--settings` JSON into its file.
     */
    ownedFlags: [
      "-p",
      "--print",
      "--output-format",
      "--input-format",
      "--verbose",
      "--setting-sources",
      "--model",
      "--effort",
    ],
  },
  pi: {
    effort: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    ownedFlags: [
      "-p",
      "--print",
      "--mode",
      "--no-session",
      "--session",
      "--session-id",
      "--session-dir",
      "--continue",
      "-c",
      "--resume",
      "-r",
      "--fork",
      "--model",
      "--thinking",
    ],
  },
};

/** Own key only: a name such as `constructor` is not a harness. */
export function isHarnessName(name: string): name is HarnessName {
  return Object.hasOwn(HARNESSES, name);
}

export function isHarnessEffort(harness: HarnessName, effort: string): boolean {
  return HARNESSES[harness].effort.includes(effort);
}
