/**
 * The external run directory: where one run's state lives (#14).
 *
 * Run state lives under `$LOOPFILE_HOME/runs/<runid>/`, with `~/.loopfile`
 * as the default home. The layout is fixed by ADR 0003 (`events.jsonl`,
 * `attempts/`), ADR 0007 (`status.json`, `activity.log`) and ADR 0008
 * (`owner.sock`, `owner.log`), plus the workspace (CONTEXT.md), `loopfile/`
 * for the Materialized Loopfile, `prompts/` for the prompt files the run
 * owner generates (#81) and `inputs/` for the run's launch inputs (#82).
 *
 * The run folder and an empty `owner.log` are made here, and nothing else: the
 * CLI's only writes (ADR 0008, #81). The spawn wiring opens that file for
 * append and hands it to the run owner as stdout and stderr, so output from a
 * run owner that dies in its first second is not lost. Everything else in the
 * folder is the run owner's to make and to write, which keeps ADR 0003's
 * one-writer rule true.
 */

import { randomInt } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Thrown when a run folder cannot be made. The message names the path. */
export class RunDirectoryError extends Error {}

/** Every path a run owns. Nothing else in the run folder is Loopfile's. */
export interface RunPaths {
  readonly root: string;
  /** The event log, the source of truth (ADR 0003). */
  readonly events: string;
  /** The status projection (ADR 0007). */
  readonly status: string;
  /** The activity log (ADR 0007). */
  readonly activity: string;
  /** The run owner's control socket (ADR 0008). */
  readonly socket: string;
  /** The run owner's stdout and stderr (ADR 0008). */
  readonly ownerLog: string;
  /** One folder per attempt, `<nnn>-<step>` (#15). */
  readonly attempts: string;
  /** The workspace path for `isolate` and `empty`; `here` uses the Target folder instead. */
  readonly workspace: string;
  /** The Materialized Loopfile. The only folder whose contents are the user's. */
  readonly loopfile: string;
  /** Prompt files the run owner generates, kept out of `loopfile/` (#81). */
  readonly prompts: string;
  /**
   * Launch inputs, one file per name (`--input <name>=<value>`, #82). Written
   * once by the run owner at start. A step reads one the same way as any
   * other data key, under `input.<name>` (#18).
   */
  readonly inputs: string;
}

/** Lowercase base32 (RFC 4648), the alphabet of a run ID's random tail. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Characters of random tail. Four break ties between runs started in one second. */
const TAIL_LENGTH = 4;

/** Bytes `sun_path` holds on each platform, the final NUL included (ADR 0008). */
const SOCKET_PATH_BYTES = { darwin: 104, linux: 108 } as const;

/**
 * The limit of this platform, the final NUL included. An unknown platform gets
 * the stricter of the two, because a wrong guess that is too generous fails at
 * bind time, where the error is far from its cause.
 */
function socketPathLimit(): number {
  const platform = process.platform as keyof typeof SOCKET_PATH_BYTES;
  return SOCKET_PATH_BYTES[platform] ?? SOCKET_PATH_BYTES.darwin;
}

/**
 * Throws unless a socket path fits in `sun_path` (ADR 0008).
 *
 * Both the launch budget below and the run owner binding a real socket ask the
 * same question, so they ask it here. The error names the path, because
 * nothing in a bind failure says the length was the problem.
 */
export function checkSocketPathLength(path: string): void {
  const limit = socketPathLimit();
  const length = Buffer.byteLength(path);
  // Not `>`: the limit counts the NUL byte the path is stored with.
  if (length >= limit) {
    throw new RunDirectoryError(
      `socket path is ${length} bytes, over the ${limit}-byte limit: ${path}. ` +
        "Set LOOPFILE_HOME to a shorter path.",
    );
  }
}

/** `~/.loopfile`, or `LOOPFILE_HOME` when it is set to something. */
export function loopfileHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LOOPFILE_HOME;
  return override ? resolve(override) : join(env.HOME ?? homedir(), ".loopfile");
}

/** A new loop ID, such as `loop-20260917-160344-k3f9`. */
export function newLoopId(at: Date = new Date()): string {
  return `loop-${newRunId(at)}`;
}

/**
 * A new run ID, such as `20260917-160344-k3f9` (#81).
 *
 * UTC date, UTC time to the second, then a random tail. It sorts by time in a
 * plain `ls`, but nothing parses it: to every reader but a human it is opaque.
 */
export function newRunId(at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replaceAll("-", "").replace("T", "-");
  let tail = "";
  for (let i = 0; i < TAIL_LENGTH; i++) tail += BASE32[randomInt(BASE32.length)];
  return `${stamp.replaceAll(":", "")}-${tail}`;
}

/**
 * False when `path` is missing; any other `stat` failure (EACCES, say) is
 * still an error. Shared by every read-only command that has to tell "no
 * such run" apart from "run exists, one of its files is not there yet"
 * (`logs`, #37; `tail`, #51), so the two never drift on what "missing" means.
 */
export async function pathExists(path: string): Promise<boolean> {
  return await stat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}

/** Every path a loop owns. */
export interface LoopPaths {
  readonly root: string;
  readonly events: string;
  readonly status: string;
  readonly loopfile: string;
  readonly socket: string;
  readonly ownerLog: string;
}

export interface CreateLoopDirectoryOptions {
  readonly home: string;
  readonly loopId: string;
  readonly targetRepository: string;
}

/** Where each of a loop's files goes, given a home and a loop ID. */
export function loopPaths(home: string, loopId: string): LoopPaths {
  const root = join(home, "loops", loopId);
  return {
    root,
    events: join(root, "events.jsonl"),
    status: join(root, "status.json"),
    loopfile: join(root, "loopfile"),
    socket: join(root, "owner.sock"),
    ownerLog: join(root, "owner.log"),
  };
}

export async function createLoopDirectory(options: CreateLoopDirectoryOptions): Promise<LoopPaths> {
  const paths = loopPaths(options.home, options.loopId);
  await checkOutsideRepository(paths.root, options.targetRepository);
  checkSocketPathLength(paths.socket);

  await makeDirectory(join(options.home, "loops"), true);
  await makeDirectory(paths.root, false);
  await writeFile(paths.ownerLog, "", { flag: "a" }).catch((error: NodeJS.ErrnoException) => {
    throw loopDirectoryError(error, paths.ownerLog);
  });
  return paths;
}

function loopDirectoryError(error: NodeJS.ErrnoException, path: string): RunDirectoryError {
  const reason =
    error.code === "EEXIST" ? "loop folder already exists" : `cannot create (${error.code})`;
  return new RunDirectoryError(`${reason}: ${path}`, { cause: error });
}

export function runPaths(home: string, runId: string): RunPaths {
  const root = join(home, "runs", runId);
  return {
    root,
    events: join(root, "events.jsonl"),
    status: join(root, "status.json"),
    activity: join(root, "activity.log"),
    socket: join(root, "owner.sock"),
    ownerLog: join(root, "owner.log"),
    attempts: join(root, "attempts"),
    workspace: join(root, "workspace"),
    loopfile: join(root, "loopfile"),
    prompts: join(root, "prompts"),
    inputs: join(root, "inputs"),
  };
}

/** What a run folder is made from. */
export interface CreateRunDirectoryOptions {
  /** The Loopfile home, usually from `loopfileHome()`. */
  readonly home: string;
  /** The run ID, usually from `newRunId()`. */
  readonly runId: string;
  /** The Target folder; empty workspaces have none and skip the containment check. */
  readonly targetRepository?: string;
  /** Every step ID in the workflow. The longest one sets the socket budget. */
  readonly stepIds: readonly string[];
}

/**
 * Makes the run folder and its empty `owner.log`, or fails saying why.
 *
 * The folder must be new: an existing one belongs to another run and is never
 * reused. Applicable checks run before anything is made, so a rejected launch
 * leaves nothing behind.
 */
export async function createRunDirectory(options: CreateRunDirectoryOptions): Promise<RunPaths> {
  const paths = runPaths(options.home, options.runId);
  if (options.targetRepository !== undefined) {
    await checkOutsideRepository(paths.root, options.targetRepository);
  }
  checkSocketBudget(paths.root, options.stepIds);

  await makeDirectory(join(options.home, "runs"), true);
  await makeDirectory(paths.root, false);
  await writeFile(paths.ownerLog, "", { flag: "a" }).catch((error: NodeJS.ErrnoException) => {
    throw runDirectoryError(error, paths.ownerLog);
  });
  return paths;
}

async function makeDirectory(path: string, recursive: boolean): Promise<void> {
  await mkdir(path, { recursive }).catch((error: NodeJS.ErrnoException) => {
    throw runDirectoryError(error, path);
  });
}

/** Keeps the real reason: an existing run folder reads plainly, anything else keeps its errno. */
function runDirectoryError(error: NodeJS.ErrnoException, path: string): RunDirectoryError {
  const reason =
    error.code === "EEXIST" ? "run folder already exists" : `cannot create (${error.code})`;
  return new RunDirectoryError(`${reason}: ${path}`, { cause: error });
}

/**
 * A run inside the target repository would write its own state into the
 * repository it is changing (ADR 0003).
 *
 * Both sides are resolved through the real filesystem, because comparing the
 * text of two paths misses a `LOOPFILE_HOME` that is a symlink into the
 * repository — the case this check exists for — and it calls `/tmp` and
 * `/private/tmp` different folders on macOS.
 */
async function checkOutsideRepository(root: string, targetRepository: string): Promise<void> {
  const repository = await realPathOfNearest(targetRepository);
  const inside = relative(repository, await realPathOfNearest(root));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new RunDirectoryError(
      `run folder would be inside the target repository ${repository}: ${root}. ` +
        "Set LOOPFILE_HOME to a path outside it.",
    );
  }
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the missing
 * names put back. The run folder and a fresh `LOOPFILE_HOME` do not exist yet,
 * and `realpath` on a missing path says nothing about the symlinks above it.
 */
async function realPathOfNearest(path: string): Promise<string> {
  const missing: string[] = [];
  let existing = resolve(path);
  for (;;) {
    const real = await realpath(existing).catch(() => undefined);
    if (real !== undefined) return join(real, ...missing.reverse());
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    missing.push(basename(existing));
    existing = parent;
  }
}

/**
 * A Unix socket path has a hard length limit, and a long `LOOPFILE_HOME` goes
 * past it (ADR 0008). The longest path is a step's socket in its attempt
 * folder, not `owner.sock` (#81), so the check builds that path from the
 * longest step ID the workflow has. Failing here means no step ever starts
 * with a socket it cannot bind.
 *
 * The attempt number is written with four digits where ADR 0003 writes three
 * (`007-fix`), so a run that passes attempt 999 cannot go over a budget that
 * was checked at launch. `sock` is `ATTEMPT_SOCKET_NAME` of
 * `attempt-directory.ts`, repeated rather than imported so this module stays
 * the one the launch path depends on; a test there holds the two together.
 */
function checkSocketBudget(root: string, stepIds: readonly string[]): void {
  const longest = stepIds.reduce((longest, id) => (id.length > longest.length ? id : longest), "");
  checkSocketPathLength(join(root, "attempts", `0000-${longest}`, "sock"));
}
