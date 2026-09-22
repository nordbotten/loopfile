/**
 * The adapter table the runtime uses (#23 D2, #24). Tests pass their own
 * table with the fake behind a real name.
 */

import type { HarnessAdapters } from "../application/harness.ts";
import { claudeAdapter } from "./claude-harness.ts";
import { piAdapter } from "./pi-harness.ts";

export const DEFAULT_HARNESS_ADAPTERS: HarnessAdapters = {
  claude: claudeAdapter,
  pi: piAdapter,
};
