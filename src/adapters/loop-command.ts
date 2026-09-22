/** `loopfile loop <source> --times N | --list <file> [--retry N] -d` (#60, #62, #64). */

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import {
  checkAgainstDeclared,
  inputHelp,
  type LaunchInputs,
  mergeInputSet,
  parseInputFlags,
  parseInputSet,
} from "../application/launch-inputs.ts";
import {
  renderOperatorConfirmation,
  renderOperatorFailureLines,
} from "../application/operator-error.ts";
import type { InputSet, LoopEvent, LoopSource } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import {
  materializeDirectory,
  materializePacked,
  materializeThin,
  materializeThinText,
} from "./directory-loader.ts";
import { openEventLog } from "./event-log.ts";
import { readStdin } from "./input.ts";
import type { LaunchIo } from "./launch-command.ts";
import {
  type PreparedLaunchSource,
  prepareLaunchSource,
  startDetachedOwner,
} from "./launch-command.ts";
import {
  createLoopDirectory,
  type LoopPaths,
  loopfileHome,
  loopPaths,
  newLoopId,
} from "./run-directory.ts";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const USAGE =
  "Usage: loopfile loop <source> (--times N | --list <file>) [--input k=v]... [--retry N] [-d]";
const HELP = `${USAGE}

Run a Loopfile repeatedly in the background. Each non-empty JSON Lines input
set in --list starts one run.
`;
const ATTACHED_HELP = "attached loops are not built yet: add -d";

export interface LoopCommandOptions {
  readonly readStdin?: () => Promise<Buffer>;
  readonly repository?: string;
  readonly readyTimeoutMs?: number;
}

type LoopIo = Pick<LaunchIo, "out" | "err" | "upgrade">;

interface LoopArgs {
  readonly source: string | undefined;
  readonly times: string[];
  readonly list: string[];
  readonly next: string[];
  readonly inputs: readonly string[];
  readonly retry: string[];
  readonly detach: boolean;
  readonly help: boolean;
}

/** Starts a detached loop after all foreground checks have passed. */
export async function loopCommand(
  argv: readonly string[],
  cli: string,
  io: LoopIo,
  env: Record<string, string | undefined>,
  options: LoopCommandOptions = {},
): Promise<number> {
  const args = parseLoopArgs(argv);
  if (args === undefined) return refuse(io, "could not parse loop arguments");
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  const retry = parseRetry(args.retry[0] ?? "0", io);
  if (retry === undefined) return 2;
  const valid = validateLoopArgs(args, io, retry);
  if (typeof valid === "number") return valid;
  return await startLoop(valid, cli, io, env, options);
}

interface ValidLoopArgs {
  readonly source: string;
  readonly count: number | undefined;
  readonly list: string | undefined;
  readonly inputs: readonly string[];
  readonly retry: number;
}

function validateLoopArgs(args: LoopArgs, io: LoopIo, retry: number): ValidLoopArgs | number {
  if (args.source === undefined) return refuse(io, "loop needs one source");
  const sources = args.times.length + args.list.length + args.next.length;
  if (sources === 0) {
    return refuse(io, "a loop needs one input source: --times, --list or --next");
  }
  if (sources > 1) return refuse(io, "a loop takes only one input source");
  if (args.next.length > 0) return refuse(io, "that loop input source is not built yet");
  if (!args.detach) return refuse(io, "attached loops are not built yet", ATTACHED_HELP);
  if (args.times.length > 0) {
    const count = parseTimes(args.times[0] as string, io);
    return count === undefined
      ? 2
      : { source: args.source, count, list: undefined, inputs: args.inputs, retry };
  }
  return { source: args.source, count: undefined, list: args.list[0], inputs: args.inputs, retry };
}

async function startLoop(
  args: ValidLoopArgs,
  cli: string,
  io: LoopIo,
  env: Record<string, string | undefined>,
  options: LoopCommandOptions,
): Promise<number> {
  const loaded = await prepareLaunchSource(args.source, io, options.readStdin ?? readStdin);
  if (!loaded.ok) return loaded.exitCode;
  const fixed = parseInputFlags(args.inputs);
  if (!fixed.ok) return refuse(io, fixed.messages, inputHelp(loaded.workflow.inputDefaults));

  let source: LoopSource;
  let fixedInputs: LaunchInputs;
  if (args.list !== undefined) {
    const sets = await readInputList(args.list, fixed.inputs, loaded.workflow, io);
    if (sets === undefined) return 2;
    source = { kind: "list", sets };
    fixedInputs = fixed.inputs;
  } else {
    const inputs = checkAgainstDeclared(
      fixed.inputs,
      loaded.workflow.inputs,
      loaded.workflow.inputDefaults,
    );
    if (!inputs.ok) return refuse(io, inputs.messages, inputHelp(loaded.workflow.inputDefaults));
    source = { kind: "times", count: args.count as number };
    fixedInputs = inputs.inputs;
  }

  const program = await programIdentity(cli).catch((error: Error) => {
    refuse(io, `cannot read the CLI entry file: ${error.message}`, USAGE, 1, "operation_failed");
    return undefined;
  });
  if (program === undefined) return 1;
  return await createAndStartLoop(
    args,
    source,
    fixedInputs,
    program,
    cli,
    io,
    env,
    options,
    loaded,
  );
}

async function createAndStartLoop(
  args: ValidLoopArgs,
  source: LoopSource,
  fixedInputs: LaunchInputs,
  program: { readonly version: string; readonly digest: string },
  cli: string,
  io: LoopIo,
  env: Record<string, string | undefined>,
  options: LoopCommandOptions,
  loaded: PreparedLaunchSource & { readonly ok: true },
): Promise<number> {
  const loopId = newLoopId();
  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const repository = options.repository ?? process.cwd();
  let paths: LoopPaths;
  try {
    paths = await createLoopDirectory({ home, loopId, targetRepository: repository });
    await materialize(loaded, args.source, paths.loopfile);
    const log = await openEventLog<LoopEvent>(paths.events);
    try {
      await log.append({
        type: "loop.created",
        loopId,
        eventFormatVersion: 1,
        repositoryPath: repository,
        loopfileName: basename(args.source),
        source,
        fixedInputs,
        retry: args.retry,
        maxRuns: null,
        pauseMs: null,
        program,
      });
    } finally {
      await log.close();
    }
  } catch (error) {
    await rm(loopPaths(home, loopId).root, { recursive: true, force: true }).catch(() => undefined);
    return refuse(io, (error as Error).message, USAGE, 1, "operation_failed");
  }

  const started = await startDetachedOwner({
    ownerId: loopId,
    paths,
    ownerEnv: env,
    cli,
    ownerCommand: "__loop-owner",
    ownerKind: "loop",
    readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
  });
  if (!started.ok) {
    io.err(
      renderOperatorFailureLines(
        started.failure.messages,
        started.failure.code,
        started.failure.help,
        started.failure.exitCode,
      ).stderr,
    );
    return started.failure.exitCode;
  }
  io.out(`${loopId}\n`);
  io.err(renderOperatorConfirmation({ started: loopId }));
  return 0;
}

async function readInputList(
  file: string,
  fixed: LaunchInputs,
  workflow: Workflow,
  io: LoopIo,
): Promise<readonly InputSet[] | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    refuse(io, `cannot read ${file}: ${(error as Error).message}`);
    return undefined;
  }

  const sets: InputSet[] = [];
  const problems: string[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const checked = checkListLine(line, index + 1, fixed, workflow);
    if (checked.ok) sets.push(checked.inputSet);
    else problems.push(...checked.messages);
  }

  if (problems.length > 0) {
    refuse(io, problems);
    return undefined;
  }
  if (sets.length === 0) {
    refuse(io, "the list has no input sets");
    return undefined;
  }
  return sets;
}

type ListLineCheck =
  | { readonly ok: true; readonly inputSet: InputSet }
  | { readonly ok: false; readonly messages: readonly string[] };

function checkListLine(
  line: string,
  lineNumber: number,
  fixed: LaunchInputs,
  workflow: Workflow,
): ListLineCheck {
  const parsed = parseInputSet(line);
  if (!parsed.ok) return lineFailure(lineNumber, parsed.messages);
  const merged = mergeInputSet(fixed, parsed.inputs);
  if (!merged.ok) return lineFailure(lineNumber, merged.messages);
  const checked = checkAgainstDeclared(merged.inputs, workflow.inputs, workflow.inputDefaults);
  return checked.ok
    ? { ok: true, inputSet: parsed.inputs }
    : lineFailure(lineNumber, checked.messages);
}

function lineFailure(lineNumber: number, messages: readonly string[]): ListLineCheck {
  return { ok: false, messages: messages.map((message) => `line ${lineNumber}: ${message}`) };
}

function parseLoopArgs(argv: readonly string[]): LoopArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        times: { type: "string", multiple: true },
        list: { type: "string", multiple: true },
        next: { type: "string", multiple: true },
        input: { type: "string", multiple: true },
        retry: { type: "string", multiple: true },
        detach: { type: "boolean", short: "d" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
    if (positionals.length > 1) return undefined;
    return {
      source: positionals[0],
      times: values.times ?? [],
      list: values.list ?? [],
      next: values.next ?? [],
      inputs: values.input ?? [],
      retry: values.retry ?? [],
      detach: values.detach === true,
      help: values.help === true,
    };
  } catch {
    return undefined;
  }
}

function parseRetry(value: string, io: LoopIo): number | undefined {
  const retry = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(retry) || retry < 0) {
    refuse(io, "--retry must be an integer of 0 or more");
    return undefined;
  }
  return retry;
}

function parseTimes(value: string, io: LoopIo): number | undefined {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
    refuse(io, "--times must be an integer of 1 or more");
    return undefined;
  }
  return count;
}

async function programIdentity(cli: string): Promise<{ version: string; digest: string }> {
  return {
    version,
    digest: createHash("sha256")
      .update(await readFile(cli))
      .digest("hex"),
  };
}

async function materialize(
  source: PreparedLaunchSource & { readonly ok: true },
  sourcePath: string,
  destination: string,
): Promise<void> {
  if (source.text !== undefined) return materializeThinText(source.text, destination);
  if (source.kind === "thin") return materializeThin(sourcePath, destination);
  if (source.kind === "packed") return materializePacked(sourcePath, destination);
  return materializeDirectory(sourcePath, destination);
}

function refuse(
  io: Pick<LoopIo, "err">,
  message: string | readonly string[],
  help = USAGE,
  exitCode: 1 | 2 = 2,
  code: "bad_argument" | "operation_failed" = "bad_argument",
): number {
  const messages = typeof message === "string" ? [message] : message;
  io.err(renderOperatorFailureLines(messages, code, help, exitCode).stderr);
  return exitCode;
}
