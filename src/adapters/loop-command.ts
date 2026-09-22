/** `loopfile loop <source> --times N | --list <file> | --next <command> -d` (#60, #62, #63). */

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import {
  checkAgainstDeclared,
  checkDeclaredInputs,
  inputHelp,
  type LaunchInputs,
  mergeInputSet,
  parseInputFlags,
  parseInputSet,
} from "../application/launch-inputs.ts";
import {
  renderOperatorConfirmation,
  renderOperatorFailure,
  renderOperatorFailureLines,
} from "../application/operator-error.ts";
import { parseStatusProjection } from "../application/status.ts";
import type { InputSet, LoopEvent, LoopSource } from "../domain/events.ts";
import type { Workflow } from "../domain/model.ts";
import type { LoopStatus, StatusProjection } from "../domain/status.ts";
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
  runPaths,
} from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const USAGE =
  "Usage: loopfile loop <source> (--times N | --list <file> | --next <command>) [--input k=v]... [--retry N] [--max-runs N] [-d]";
const HELP = `${USAGE}

Run a Loopfile repeatedly in the background. Each non-empty JSON Lines input
set in --list starts one run. --next runs a command before each run; its stdout
is one JSON input set, or whitespace to end the loop.
`;
export interface LoopCommandOptions {
  readonly readStdin?: () => Promise<Buffer>;
  readonly repository?: string;
  readonly readyTimeoutMs?: number;
  /** Overridable for tests only. Production follows loop status every 500 ms. */
  readonly pollMs?: number;
  /** Overridable for tests only. */
  readonly ownerPingTimeoutMs?: number;
}

type LoopIo = Pick<LaunchIo, "out" | "err" | "upgrade">;

interface LoopArgs {
  readonly source: string | undefined;
  readonly times: string[];
  readonly list: string[];
  readonly next: string[];
  readonly retry: string[];
  readonly maxRuns: string[];
  readonly inputs: readonly string[];
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
  const valid = validateLoopArgs(args, io);
  if (typeof valid === "number") return valid;
  return await startLoop(valid, cli, io, env, options);
}

interface ValidLoopArgs {
  readonly source: string;
  readonly count: number | undefined;
  readonly list: string | undefined;
  readonly next: string | undefined;
  readonly retry: number;
  readonly maxRuns: number | undefined;
  readonly inputs: readonly string[];
  readonly detach: boolean;
}

function validateLoopArgs(args: LoopArgs, io: LoopIo): ValidLoopArgs | number {
  if (args.source === undefined) return refuse(io, "loop needs one source");
  const sources = args.times.length + args.list.length + args.next.length;
  if (sources === 0) {
    return refuse(io, "a loop needs one input source: --times, --list or --next");
  }
  if (sources > 1) return refuse(io, "a loop takes only one input source");
  const limits = parseLoopLimits(args, io);
  if (limits === undefined) return 2;
  return loopSourceArgs(args, limits, io);
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

  const inputs = await prepareLoopInputs(args, fixed.inputs, loaded.workflow, io);
  if (inputs === undefined) return 2;
  const { source, fixedInputs } = inputs;

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

interface PreparedLoopInputs {
  readonly source: LoopSource;
  readonly fixedInputs: LaunchInputs;
}

async function prepareLoopInputs(
  args: ValidLoopArgs,
  fixed: LaunchInputs,
  workflow: Workflow,
  io: LoopIo,
): Promise<PreparedLoopInputs | undefined> {
  if (args.next !== undefined) {
    const inputs = checkDeclaredInputs(fixed, workflow.inputs);
    if (!inputs.ok) {
      refuse(io, inputs.messages, inputHelp(workflow.inputDefaults));
      return undefined;
    }
    return { source: { kind: "next", command: args.next }, fixedInputs: fixed };
  }
  if (args.list !== undefined) {
    const sets = await readInputList(args.list, fixed, workflow, io);
    return sets === undefined ? undefined : { source: { kind: "list", sets }, fixedInputs: fixed };
  }
  const inputs = checkAgainstDeclared(fixed, workflow.inputs, workflow.inputDefaults);
  if (!inputs.ok) {
    refuse(io, inputs.messages, inputHelp(workflow.inputDefaults));
    return undefined;
  }
  return { source: { kind: "times", count: args.count as number }, fixedInputs: inputs.inputs };
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
        maxRuns: args.maxRuns ?? null,
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
  if (args.detach) return 0;
  return await followAttachedLoop(loopId, home, io.err, options);
}

interface ObservedRun {
  readonly index: number;
  readonly runId: string;
  ended: boolean;
}

/** Follows an attached loop without opening a run monitor. */
async function followAttachedLoop(
  loopId: string,
  home: string,
  err: (text: string) => void,
  options: LoopCommandOptions,
): Promise<number> {
  const interrupted = new AbortController();
  const onInterrupt = (): void => interrupted.abort();
  process.once("SIGINT", onInterrupt);
  try {
    return await followLoop(loopId, home, err, options, interrupted.signal);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

async function followLoop(
  loopId: string,
  home: string,
  err: (text: string) => void,
  options: LoopCommandOptions,
  signal: AbortSignal,
): Promise<number> {
  const paths = loopPaths(home, loopId);
  const observed = new Map<string, ObservedRun>();
  const pollMs = options.pollMs ?? 500;

  for (;;) {
    if (signal.aborted) return 0;
    const statusExit = await observeLoopStatus(
      await readLoopStatus(paths.status),
      observed,
      home,
      err,
      options,
      signal,
    );
    if (statusExit !== undefined) return statusExit;

    const ownerExit = await observeLoopOwner(
      loopId,
      paths.socket,
      paths.status,
      observed,
      home,
      err,
      options,
      signal,
    );
    if (ownerExit !== undefined) return ownerExit;
    await sleepForLoop(pollMs, signal);
  }
}

async function observeLoopStatus(
  status: LoopStatus | undefined,
  observed: Map<string, ObservedRun>,
  home: string,
  err: (text: string) => void,
  options: LoopCommandOptions,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (status === undefined) return undefined;
  await reportRuns(status, observed, home, err, options, signal);
  if (signal.aborted) return 0;
  return status.state === "running" ? undefined : reportLoopEnd(status, err);
}

async function observeLoopOwner(
  loopId: string,
  socketPath: string,
  statusPath: string,
  observed: Map<string, ObservedRun>,
  home: string,
  err: (text: string) => void,
  options: LoopCommandOptions,
  signal: AbortSignal,
): Promise<number | undefined> {
  if ((await pingOwner(socketPath, options.ownerPingTimeoutMs)) === loopId) return undefined;
  const finalExit = await observeLoopStatus(
    await readLoopStatus(statusPath),
    observed,
    home,
    err,
    options,
    signal,
  );
  if (finalExit !== undefined) return finalExit;
  if (signal.aborted) return 0;
  err(
    renderOperatorFailure(
      {
        summary: `the loop owner for ${loopId} is gone`,
        code: "owner_gone",
        help: `Resume the crashed loop with: loopfile resume ${loopId}`,
      },
      2,
    ).stderr,
  );
  return 2;
}

async function reportRuns(
  status: LoopStatus,
  observed: Map<string, ObservedRun>,
  home: string,
  err: (text: string) => void,
  options: LoopCommandOptions,
  signal: AbortSignal,
): Promise<void> {
  for (const [position, runId] of status.runIds.entries()) {
    if (signal.aborted) return;
    let run = observed.get(runId);
    if (run === undefined) {
      run = { index: position + 1, runId, ended: false };
      observed.set(runId, run);
      err(`run: ${run.index} ${run.runId} started\n`);
    }
    if (run.ended) continue;
    const state = await childEndState(
      home,
      runId,
      status.state !== "running",
      options.ownerPingTimeoutMs,
    );
    if (state === undefined || signal.aborted) continue;
    run.ended = true;
    err(`run: ${run.index} ${run.runId} ${state}\n`);
  }
}

type LoopRunEndState = StatusProjection["state"] | "crashed";

async function childEndState(
  home: string,
  runId: string,
  loopEnded: boolean,
  ownerPingTimeoutMs: number | undefined,
): Promise<LoopRunEndState | undefined> {
  const status = await readChildStatus(runPaths(home, runId).status);
  if (status === undefined) return loopEnded ? "crashed" : undefined;
  if (status.state !== "running") return status.state;
  return (await pingOwner(runPaths(home, runId).socket, ownerPingTimeoutMs)) === runId
    ? undefined
    : "crashed";
}

async function readLoopStatus(path: string): Promise<LoopStatus | undefined> {
  return await readFile(path, "utf8")
    .then((text) => JSON.parse(text) as LoopStatus)
    .catch(() => undefined);
}

async function readChildStatus(path: string): Promise<StatusProjection | undefined> {
  return await readFile(path, "utf8")
    .then((text) => parseStatusProjection(JSON.parse(text)))
    .catch(() => undefined);
}

function reportLoopEnd(status: LoopStatus, err: (text: string) => void): number {
  const reason = status.endReason ?? "unknown";
  if (status.state === "completed") {
    err(renderOperatorConfirmation({ ended: `${status.loopId} ${status.state} ${reason}` }));
    return 0;
  }
  const detail = status.detail === null || status.detail === "" ? "" : ` (${status.detail})`;
  err(
    renderOperatorFailure(
      {
        summary: `loop ${status.loopId} ${status.state}: ${reason}${detail}`,
        code: "operation_failed",
        help: `See each run with: loopfile result ${status.loopId}`,
      },
      1,
    ).stderr,
  );
  return 1;
}

function sleepForLoop(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout;
    const onAbort = (): void => done();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
        retry: { type: "string", multiple: true },
        "max-runs": { type: "string", multiple: true },
        input: { type: "string", multiple: true },
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
      retry: values.retry ?? [],
      maxRuns: values["max-runs"] ?? [],
      inputs: values.input ?? [],
      detach: values.detach === true,
      help: values.help === true,
    };
  } catch {
    return undefined;
  }
}

function loopSourceArgs(
  args: LoopArgs,
  limits: { readonly retry: number; readonly maxRuns: number | undefined },
  io: LoopIo,
): ValidLoopArgs | number {
  if (args.times.length > 0) {
    const count = parseTimes(args.times[0] as string, io);
    if (count === undefined) return 2;
    return {
      source: args.source as string,
      count,
      list: undefined,
      next: undefined,
      ...limits,
      inputs: args.inputs,
      detach: args.detach,
    };
  }
  if (args.list.length > 0) {
    return {
      source: args.source as string,
      count: undefined,
      list: args.list[0],
      next: undefined,
      ...limits,
      inputs: args.inputs,
      detach: args.detach,
    };
  }
  return {
    source: args.source as string,
    count: undefined,
    list: undefined,
    next: args.next[0],
    ...limits,
    inputs: args.inputs,
    detach: args.detach,
  };
}

function parseLoopLimits(
  args: LoopArgs,
  io: LoopIo,
): { readonly retry: number; readonly maxRuns: number | undefined } | undefined {
  const retry = parseOptionalRetry(args.retry, io);
  if (retry === undefined) return undefined;
  const maxRuns = parseOptionalCount(args.maxRuns, "--max-runs", io);
  if (maxRuns === undefined && args.maxRuns.length > 0) return undefined;
  return { retry, maxRuns };
}

function parseTimes(value: string, io: LoopIo): number | undefined {
  return parseCount(value, "--times", io);
}

function parseOptionalRetry(values: readonly string[], io: LoopIo): number | undefined {
  if (values.length === 0) return 0;
  const value = values[0] as string;
  const retry = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(retry)) {
    refuse(io, "--retry must be an integer of 0 or more");
    return undefined;
  }
  return retry;
}

function parseOptionalCount(
  values: readonly string[],
  flag: string,
  io: LoopIo,
): number | undefined {
  return values.length === 0 ? undefined : parseCount(values[0] as string, flag, io);
}

function parseCount(value: string, flag: string, io: LoopIo): number | undefined {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
    refuse(io, `${flag} must be an integer of 1 or more`);
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
