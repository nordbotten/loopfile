/**
 * `logs <runid> [<attempt>]`: the read-only view of one attempt's raw output
 * (#37, decided in #91).
 *
 * Parsing the command's own arguments, picking an attempt or iteration out of
 * what is on disk, and rendering headers are all pure, so they are tested
 * without a filesystem. Reading the run and attempt folders is
 * `src/adapters/logs-command.ts`.
 */

/** `logs`'s own arguments, once parsed. */
export interface LogsArgs {
  readonly ok: true;
  readonly runId: string;
  /** An attempt number (`7`, `007`) or folder name (`007-fix`). Left out means the newest. */
  readonly attempt?: string;
  /** `--stdout` or `--stderr`. Left out means both, each behind a header. */
  readonly stream?: "stdout" | "stderr";
  /** `--iteration <n>`. Only valid on a Ralph attempt. */
  readonly iteration?: number;
  /** Print the run owner's raw log instead of an attempt's output. */
  readonly owner?: true;
}

/** Why `logs`'s own arguments could not be used. */
export interface LogsFailure {
  readonly ok: false;
  readonly message: string;
}

const USAGE = "Usage: loopfile logs <runid> [<attempt>] [--stdout | --stderr] [--iteration <n>]";

/**
 * `logs`'s own arguments, or the failure to report when they are unusable.
 *
 * Split into one reader per piece of the grammar (the run ID, the optional
 * attempt, the flags) so each stays simple enough to read at a glance: a
 * single function trying to do all of it at once is exactly what runs its
 * branch count past what a reader — or the CRAP bar — can follow.
 */
export function parseLogsArgs(argv: readonly string[]): LogsArgs | LogsFailure {
  const runId = readRunId(argv);
  if (typeof runId !== "string") return runId;

  if (argv[2] === "--owner") {
    if (argv.length === 3) return { ok: true, runId, owner: true };
    return {
      ok: false,
      message: `--owner cannot be combined with attempt or stream options.\n${USAGE}`,
    };
  }

  const { attempt, index } = readAttempt(argv);
  const flags = readFlags(argv, index);
  if (!flags.ok) return flags;

  return { ok: true, runId, attempt, stream: flags.stream, iteration: flags.iteration };
}

function readRunId(argv: readonly string[]): string | LogsFailure {
  const runId = argv[1];
  if (!runId || runId.startsWith("--")) {
    return { ok: false, message: `\`logs\` needs a run ID.\n${USAGE}` };
  }
  return runId;
}

/** The optional attempt positional right after the run ID, and where the flags start. */
function readAttempt(argv: readonly string[]): { attempt: string | undefined; index: number } {
  const maybeAttempt = argv[2];
  if (maybeAttempt !== undefined && !maybeAttempt.startsWith("--")) {
    return { attempt: maybeAttempt, index: 3 };
  }
  return { attempt: undefined, index: 2 };
}

interface LogsFlags {
  readonly ok: true;
  readonly stream?: "stdout" | "stderr";
  readonly iteration?: number;
}

/** `--stdout`/`--stderr`/`--iteration <n>`, in any order, from `start` on. */
function readFlags(argv: readonly string[], start: number): LogsFlags | LogsFailure {
  let stream: "stdout" | "stderr" | undefined;
  let iteration: number | undefined;

  for (let index = start; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--stdout" || token === "--stderr") {
      const read = readStreamFlag(token, stream);
      if (typeof read !== "string") return read;
      stream = read;
    } else if (token === "--iteration") {
      const read = readIterationFlag(argv[index + 1]);
      if (typeof read !== "number") return read;
      iteration = read;
      index += 1;
    } else {
      return { ok: false, message: `unknown argument: ${token}\n${USAGE}` };
    }
  }

  return { ok: true, stream, iteration };
}

function readStreamFlag(
  token: "--stdout" | "--stderr",
  current: "stdout" | "stderr" | undefined,
): "stdout" | "stderr" | LogsFailure {
  if (current !== undefined) {
    return { ok: false, message: `--stdout and --stderr cannot both be given.\n${USAGE}` };
  }
  return token === "--stdout" ? "stdout" : "stderr";
}

function readIterationFlag(raw: string | undefined): number | LogsFailure {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return { ok: false, message: `--iteration needs a number.\n${USAGE}` };
  }
  return Number(raw);
}

/**
 * An attempt folder's name, `<nnn>-<step>` (#15): digits, a hyphen, then a
 * step ID (`NAME_PATTERN`). Anything else in `attempts/` is not an attempt —
 * a stray directory left by hand, say — and is never shown or picked as
 * "newest", rather than sorting as attempt number `NaN`.
 */
const ATTEMPT_FOLDER_NAME = /^\d+-[a-z][a-z0-9_-]{0,63}$/;

/** True when `name` is a real attempt folder name. */
export function isAttemptFolderName(name: string): boolean {
  return ATTEMPT_FOLDER_NAME.test(name);
}

/**
 * The attempt to show: the one `requested` names, or the newest when nothing
 * was asked for. `requested` matches an attempt folder name exactly
 * (`007-fix`) or, being all digits, its attempt number (`7`, `007`) — never
 * both, because a step ID never starts with a digit (`NAME_PATTERN`).
 *
 * `available` is expected to already be filtered to `isAttemptFolderName`.
 */
export function selectAttempt(
  available: readonly string[],
  requested: string | undefined,
): string | undefined {
  if (requested === undefined) return sortAttempts(available).at(-1);
  if (available.includes(requested)) return requested;
  if (/^\d+$/.test(requested)) {
    const number = Number(requested);
    return available.find((id) => attemptNumber(id) === number);
  }
  return undefined;
}

function attemptNumber(attemptId: string): number {
  return Number(attemptId.split("-", 1)[0]);
}

/** Attempt folder names, oldest first: how listings and "unknown attempt" errors order them. */
export function sortAttempts(available: readonly string[]): readonly string[] {
  return [...available].sort((a, b) => attemptNumber(a) - attemptNumber(b));
}

/** The iteration to show, or nothing when `requested` names none that exist. */
export function selectIteration(
  available: readonly number[],
  requested: number,
): number | undefined {
  return available.includes(requested) ? requested : undefined;
}

/** A stream's header line, printed to stderr ahead of its bytes on stdout. */
export function streamHeader(stream: "stderr" | "stdout"): string {
  return `--- ${stream} ---\n`;
}

/** An iteration's header line, printed to stderr ahead of its streams. */
export function iterationHeader(iteration: number): string {
  return `--- iteration ${String(iteration).padStart(2, "0")} ---\n`;
}

export function unknownRunMessage(runId: string): string {
  return `unknown run: ${runId}`;
}

export function unknownAttemptMessage(runId: string, available: readonly string[]): string {
  if (available.length === 0) return `run ${runId} has no attempts`;
  return `unknown attempt for run ${runId}. Valid attempts: ${sortAttempts(available).join(", ")}`;
}

export function iterationOnNonRalphMessage(attemptId: string): string {
  return `--iteration only works on a Ralph attempt, and ${attemptId} is not one`;
}

export function unknownIterationMessage(attemptId: string, available: readonly number[]): string {
  if (available.length === 0) return `attempt ${attemptId} has no iterations`;
  const list = [...available].sort((a, b) => a - b).map((n) => String(n).padStart(2, "0"));
  return `unknown iteration for attempt ${attemptId}. Valid iterations: ${list.join(", ")}`;
}
