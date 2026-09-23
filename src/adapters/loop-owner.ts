/** The detached loop owner process (#60). */

import { hostname } from "node:os";
import type { LoopEvent } from "../domain/events.ts";
import { openEventLog } from "./event-log.ts";
import { createLoopCancelRequests, runLoop } from "./loop-run.ts";
import { loopfileHome, loopPaths } from "./run-directory.ts";
import { startControlOwner } from "./run-owner.ts";

/** Runs a loop owner to its end and returns its process exit code. */
export async function loopOwnerCommand(
  args: readonly string[],
  cli: string,
  err: (text: string) => void,
  env: Record<string, string | undefined>,
): Promise<number> {
  const [loopId, ...extra] = args;
  if (loopId === undefined || loopId === "" || extra.length > 0) {
    err("loopfile: __loop-owner needs one loop ID\n");
    return 2;
  }

  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const ownerEnv = { ...env };
  const killLeftovers = ownerEnv.LOOPFILE_KILL_LEFTOVERS === "1";
  delete ownerEnv.LOOPFILE_KILL_LEFTOVERS;
  const paths = loopPaths(home, loopId);
  const cancelRequests = createLoopCancelRequests();
  try {
    const owner = await startControlOwner({
      socketPath: paths.socket,
      ownerId: loopId,
      ownerKind: "loop",
      onLoopCancel: (mode) => cancelRequests.request(mode),
      beforeReady: async () => {
        const log = await openEventLog<LoopEvent>(paths.events);
        try {
          await log.append({ type: "owner.started", pid: process.pid, host: hostname() });
        } finally {
          await log.close();
        }
      },
    });
    try {
      await runLoop(home, loopId, { cli, env: ownerEnv, killLeftovers, cancelRequests });
    } finally {
      cancelRequests.close();
      await owner.close();
    }
    return 0;
  } catch (error) {
    err(`loopfile: ${reasonOf(error)}\n`);
    return 1;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
