/** `loopfile prune`: remove every ended run that cannot be resumed. */

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderOperatorFailure } from "../application/operator-error.ts";
import { parseEventLog, replay } from "../application/replay.ts";
import { isRunId } from "../application/run-list.ts";
import { removeRun } from "./remove-command.ts";
import { loopfileHome, runPaths } from "./run-directory.ts";

const USAGE = "Usage: loopfile prune [--older-than <age>] [--dry-run]";
const HELP = `${USAGE}

Remove every ended run that cannot be resumed. Crashed and internal-error runs
stay for an operator to inspect or remove individually. --older-than selects
runs ended longer ago than an age such as 30m, 12h, or 7d. --dry-run lists
selected runs without removing them. Exit 0 means every selected run was
removed; 1 means one or more runs were skipped.
`;

/** Runs `prune`. Returns the exit code. */
export async function pruneCommand(
  argv: readonly string[],
  out: (text: string) => void,
  err: (text: string) => void,
  env: Record<string, string | undefined>,
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const args = parsePruneArgs(argv);
  if (!args.ok) {
    err(renderOperatorFailure({ summary: args.summary, code: "bad_argument", help: USAGE }).stderr);
    return 2;
  }

  return await pruneAt(loopfileHome(env as NodeJS.ProcessEnv), err, args);
}

interface PruneArgs {
  readonly dryRun: boolean;
  readonly olderThanMs: number | undefined;
}

function parsePruneArgs(
  argv: readonly string[],
): ({ readonly ok: true } & PruneArgs) | { readonly ok: false; readonly summary: string } {
  let dryRun = false;
  let olderThanMs: number | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token !== "--older-than") return { ok: false, summary: `unknown argument: ${token}` };

    const age = argv[index + 1];
    if (age === undefined) return { ok: false, summary: "--older-than needs an age" };
    const parsed = ageMilliseconds(age);
    if (parsed === undefined) return { ok: false, summary: `invalid age: ${age}` };
    if (olderThanMs !== undefined)
      return { ok: false, summary: "--older-than may only be given once" };
    olderThanMs = parsed;
    index += 1;
  }
  return { ok: true, dryRun, olderThanMs };
}

function ageMilliseconds(age: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(age);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  if (!Number.isSafeInteger(amount) || amount > Number.MAX_SAFE_INTEGER / unit) return undefined;
  return amount * unit;
}

async function pruneAt(
  home: string,
  err: (text: string) => void,
  args: PruneArgs,
): Promise<number> {
  const runIds = await prunableRunIds(home, args.olderThanMs, Date.now()).catch((error) => {
    err(
      renderOperatorFailure({
        summary: error instanceof Error ? error.message : String(error),
        code: "operation_failed",
        help: "Check that the runs folder is readable, then try again.",
      }).stderr,
    );
    return undefined;
  });
  if (runIds === undefined) return 2;

  if (args.dryRun) {
    for (const runId of runIds) err(`would_remove: ${runId}\n`);
    return 0;
  }

  const result = await removeRuns(home, runIds);
  err(
    `removed: ${result.removed}\nskipped: ${result.skipped.length}\n${result.skipped.join("\n")}${result.skipped.length === 0 ? "" : "\n"}freed: ${formatBytes(result.freed)}\n`,
  );
  return result.skipped.length === 0 ? 0 : 1;
}

interface PruneResult {
  readonly removed: number;
  readonly skipped: readonly string[];
  readonly freed: number;
}

async function removeRuns(home: string, runIds: readonly string[]): Promise<PruneResult> {
  const skipped: string[] = [];
  let removed = 0;
  let freed = 0;
  for (const runId of runIds) {
    const paths = runPaths(home, runId);
    const bytes = await directoryBytes(paths.root).catch(() => 0);
    const result = await removeRun(home, runId);
    if (result.ok) {
      removed += 1;
      freed += bytes;
    } else {
      skipped.push(`skipped: ${runId} ${result.failure.code} ${paths.workspace}`);
    }
  }
  return { removed, skipped, freed };
}

async function prunableRunIds(
  home: string,
  olderThanMs: number | undefined,
  now: number,
): Promise<readonly string[]> {
  const entries = await readdir(join(home, "runs"), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const selected: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isRunId(entry.name)) continue;
    const events = await readFile(runPaths(home, entry.name).events, "utf8")
      .then(parseEventLog)
      .catch(() => undefined);
    if (events !== undefined && cannotResume(events) && endedBefore(events, olderThanMs, now))
      selected.push(entry.name);
  }
  return selected;
}

function cannotResume(events: Parameters<typeof replay>[0]): boolean {
  const result = replay(events).result;
  return (
    result?.result === "success" ||
    result?.result === "cancelled" ||
    (result?.result === "failure" && result.reason !== "internal_error")
  );
}

function endedBefore(
  events: Parameters<typeof replay>[0],
  olderThanMs: number | undefined,
  now: number,
): boolean {
  if (olderThanMs === undefined) return true;
  const end = events.findLast(
    (event) => event.type === "run.ended" || event.type === "run.cancelled",
  );
  return end !== undefined && Date.parse(end.at) < now - olderThanMs;
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(child) : (await lstat(child)).size;
  }
  return bytes;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${bytes % 1 === 0 ? bytes : bytes.toFixed(1)} ${units[index]}`;
}
