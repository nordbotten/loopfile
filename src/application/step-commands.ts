/**
 * What a step command prints, and the exit code that goes with it (#83).
 *
 * Step commands talk to a step, not to a person, so the output is agent-first
 * `key: value` lines: one fact per line, no colour and no prose. There is no
 * JSON form until something needs to parse a confirmation.
 *
 * Rendering is pure. The caller writes the text to stderr, because stdout
 * carries payload bytes only — `loopfile data get spec.md > spec.md` has to
 * work with no flag.
 */

/**
 * Why a step command failed. A closed list, so a step can branch further than
 * the three exit codes without reading the message text.
 */
export type StepErrorCode =
  | "unknown_key"
  | "bad_outcome"
  | "missing_arg"
  | "stale_attempt"
  | "no_endpoint"
  | "invalid_key"
  | "write_kind_mismatch";

/** A step command that did what it was asked. */
export interface StepSuccess {
  readonly ok: true;
  /** What happened, as the `ok:` line. For example `read spec.full`. */
  readonly summary: string;
  /** Command-specific `key: value` lines, printed in insertion order. */
  readonly fields?: Readonly<Record<string, string>>;
}

/** A step command that did not. */
export interface StepFailure {
  readonly ok: false;
  /** What went wrong, as the `error:` line. */
  readonly summary: string;
  readonly code: StepErrorCode;
  /** What to try next, one line each. A failure always says something. */
  readonly help: readonly string[];
}

/** What a step command reports to the step that called it. */
export type StepReport = StepSuccess | StepFailure;

/** Text for stderr and the process exit code. Nothing here goes to stdout. */
export interface RenderedStep {
  readonly stderr: string;
  readonly exitCode: number;
}

/** One step command, as a step types it. */
export interface StepCommand {
  /** The CLI's command table key. `data get` and `data put` share one. */
  readonly name: string;
  /** The whole call, for the help block. */
  readonly usage: string;
  readonly summary: string;
}

/**
 * The step command group: the whole surface a running step has (ADR 0005).
 * They live in the `loopfile` binary, not a second one, and their behaviour is
 * each command's own concern (#19, #20, #26).
 */
export const STEP_COMMANDS: readonly StepCommand[] = [
  {
    name: "result",
    usage: "result <outcome> [--message <text>]",
    summary: "Report this step's outcome",
  },
  { name: "data", usage: "data get <key>", summary: "Read a data key. Raw bytes on stdout" },
  { name: "data", usage: "data put <key> <file|->", summary: "Publish a data key from a file" },
  {
    name: "data",
    usage: "data append <key> <value>",
    summary: "Add a value to a data key's history",
  },
];

/** True when `name` is a step command's table key. */
function isStepCommand(name: string | undefined): name is string {
  return STEP_COMMANDS.some((command) => command.name === name);
}

/**
 * Whether a step command may run at all. `LOOPFILE_ENDPOINT` is the one value
 * that says there is a run owner to call (ADR 0005), so it is also the whole
 * test for "inside an attempt". The rule is spelled once, here.
 */
function insideAttempt(endpoint: string | undefined): boolean {
  return endpoint !== undefined && endpoint !== "";
}

/**
 * The help block for the step command group, or nothing outside an attempt: an
 * operator reading `loopfile --help` on their own machine can call none of
 * these, so listing them there is noise.
 */
export function stepCommandHelp(endpoint: string | undefined): string {
  if (!insideAttempt(endpoint)) return "";
  const width = Math.max(...STEP_COMMANDS.map((command) => command.usage.length));
  const lines = STEP_COMMANDS.map(
    (command) => `  ${command.usage.padEnd(width + 2)}${command.summary}`,
  );
  return `\nStep commands (inside an attempt only):\n${lines.join("\n")}\n`;
}

/**
 * The `LOOPFILE_ENDPOINT` check every step command shares (ADR 0005): the one
 * value that says there is a run owner to call. Missing means the command was
 * run outside an attempt, or the attempt it belonged to has ended, and no
 * retry of the same call can help — so it is a blocked failure, not a fixable
 * one. Returns nothing when the command may run.
 */
export function requireEndpoint(
  command: string,
  endpoint: string | undefined,
): StepFailure | undefined {
  if (insideAttempt(endpoint)) return undefined;
  return {
    ok: false,
    summary: `\`loopfile ${command}\` works only inside a running attempt`,
    code: "no_endpoint",
    help: [
      "LOOPFILE_ENDPOINT is unset, so there is no run owner to call",
      "Run this from a step of a running Loopfile attempt, not from a shell",
    ],
  };
}

/**
 * Codes the step itself can act on: a wrong key, a missing argument, an
 * outcome the step does not have. Everything else is the run's problem, not
 * the step's, so retrying the same call cannot help.
 */
const FIXABLE: readonly StepErrorCode[] = [
  "unknown_key",
  "bad_outcome",
  "missing_arg",
  "invalid_key",
  "write_kind_mismatch",
];

/**
 * Keeps a value on one line, so a reader can split the output on newlines and
 * never look for a continuation. Only a value that would break that is quoted:
 * a plain one reads as itself.
 */
function renderValue(value: string): string {
  if (!/[\n"]/.test(value) && value === value.trim()) return value;
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  return `"${escaped}"`;
}

/** Renders a step command's report as agent-first `key: value` lines. */
export function renderStep(report: StepReport): RenderedStep {
  if (report.ok) {
    const lines = [`ok: ${report.summary}`];
    for (const [key, value] of Object.entries(report.fields ?? {})) {
      lines.push(`${key}: ${renderValue(value)}`);
    }
    return { stderr: `${lines.join("\n")}\n`, exitCode: 0 };
  }

  const lines = [`error: ${report.summary}`, `code: ${report.code}`];
  lines.push(`help[${report.help.length}]:`);
  for (const hint of report.help) lines.push(`  ${hint}`);
  return {
    stderr: `${lines.join("\n")}\n`,
    exitCode: FIXABLE.includes(report.code) ? 1 : 2,
  };
}

/**
 * What the CLI does with `argv` when it names a step command, or nothing when
 * it does not and the operator command table should have it.
 *
 * The whole reply goes to stderr. A step command writes nothing to stdout but
 * the payload bytes of `data get`, so a step that redirects stdout to a file
 * gets its payload and nothing else — not a confirmation, not an error, and
 * never the operator help (#83). That holds whether or not the command's own
 * behaviour exists yet, which is why the operator table never sees these
 * names.
 */
export function routeStepCommand(
  argv: readonly string[],
  endpoint: string | undefined,
): RenderedStep | undefined {
  const name = argv[0];
  if (!isStepCommand(name)) return undefined;

  const blocked = requireEndpoint(name, endpoint);
  if (blocked) return renderStep(blocked);

  // The group exists before its commands do. Each of #19, #20 and
  // #26 replaces this line with its own dispatch. Until then the command is
  // recognised inside an attempt but cannot run, which is a build state and
  // not one of the five failure codes a step can act on.
  return { stderr: `loopfile: \`${name}\` is not built yet\n`, exitCode: 2 };
}
