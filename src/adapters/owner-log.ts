import { readFile } from "node:fs/promises";

/** The trailing owner-log lines shown whenever a run owner fails. */
export const OWNER_LOG_TAIL_LINES = 20;

/** The launch and recovery error detail for a run owner's log. */
export async function ownerLogHelp(path: string): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  const tail = text.trimEnd().split("\n").slice(-OWNER_LOG_TAIL_LINES).join("\n");
  return `End of ${path}:\n${tail}`;
}
