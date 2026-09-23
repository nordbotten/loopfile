/**
 * Removing a test folder that detached owners write into. Test code only;
 * this file only exports, like `fake-harness.test.ts`.
 *
 * A loop or run owner goes on writing after its end event: its status file,
 * then its socket. An `rm` that runs while an owner is alive can fail with
 * ENOTEMPTY, because the owner makes a file in a folder `rm` has emptied.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * The pid of every `owner.started` in an events file, the first one first.
 * Lines that do not parse are skipped: some tests write a broken log on purpose.
 */
export async function ownerPids(eventsPath: string): Promise<number[]> {
  const text = await readFile(eventsPath, "utf8").catch(() => "");
  return text.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; pid?: unknown };
      return event.type === "owner.started" && typeof event.pid === "number" ? [event.pid] : [];
    } catch {
      return [];
    }
  });
}

/** False for a pid we may not signal: a test owner is ours, a made-up pid such as 1 is not. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every owner under `root` that is another live process, or undefined while the tree moves. */
async function liveOwners(root: string): Promise<number[] | undefined> {
  const names = await readdir(root, { recursive: true }).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" && error.path === root ? [] : undefined,
  );
  if (names === undefined) return undefined;
  const pids: number[] = [];
  for (const name of names) {
    if (basename(name) === "events.jsonl") pids.push(...(await ownerPids(join(root, name))));
  }
  // An in-process owner is this test process; it is not waited for.
  return pids.filter((pid) => pid !== process.pid && processAlive(pid));
}

/**
 * Waits until no owner recorded under `root` is alive, then removes `root`.
 * It looks again after each wait, since a loop owner can start a run owner
 * until it exits.
 */
export async function removeAfterOwnersExit(root: string): Promise<void> {
  for (let tries = 0; tries < 800; tries += 1) {
    const live = await liveOwners(root);
    if (live?.length === 0) {
      await rm(root, { recursive: true, force: true });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`an owner under ${root} did not exit`);
}
