/** `discoverLoops`: the filesystem side of `loopfile list`'s loop rows. */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveLoopListEntry, isLoopId, sortLoopListEntries } from "../application/run-list.ts";
import type { LoopListEntry } from "../domain/run-list.ts";
import type { LoopStatus } from "../domain/status.ts";
import { loopfileHome, loopPaths } from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

/** Overridable for tests only. */
export interface DiscoverLoopsOptions {
  readonly now?: () => Date;
  readonly pingTimeoutMs?: number;
}

/** Every loop under `LOOPFILE_HOME`, active first and newest first. */
export async function discoverLoops(
  env: NodeJS.ProcessEnv = process.env,
  options: DiscoverLoopsOptions = {},
): Promise<readonly LoopListEntry[]> {
  const home = loopfileHome(env);
  const loopIds = await listLoopIds(join(home, "loops"));
  const now = (options.now?.() ?? new Date()).toISOString();
  const entries = await Promise.all(
    loopIds.map(async (loopId) => {
      const status = await readLoopStatus(loopPaths(home, loopId).status);
      if (status === undefined) return undefined;
      const alive =
        status.state !== "running" ||
        (await pingOwner(loopPaths(home, loopId).socket, options.pingTimeoutMs)) === loopId;
      return deriveLoopListEntry({ status, alive, now });
    }),
  );
  return sortLoopListEntries(
    entries.filter((entry): entry is LoopListEntry => entry !== undefined),
  );
}

async function readLoopStatus(path: string): Promise<LoopStatus | undefined> {
  return await readFile(path, "utf8")
    .then((text) => JSON.parse(text) as LoopStatus)
    .catch(() => undefined);
}

/** Every loop ID under `loops/`; unrelated folders are ignored. */
async function listLoopIds(loopsDir: string): Promise<readonly string[]> {
  const entries = await readdir(loopsDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && isLoopId(entry.name))
    .map((entry) => entry.name);
}
