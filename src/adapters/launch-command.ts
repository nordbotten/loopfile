/**
 * `loopfile <source> [-d] [--input <name>=<value>]...`: the default command (#35).
 *
 * Everything that can fail runs here, in the foreground, before a run owner
 * exists (ADR 0006, ADR 0008): the format check and upgrade prompt, the load,
 * the inputs. Then the CLI makes the run folder and its empty `owner.log`,
 * starts the run owner detached and waits for its "ready". The CLI writes no
 * run state: the run owner makes the Materialized Loopfile, `run.created` and
 * the inputs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { connect } from "node:net";
import { parseArgs } from "node:util";
import {
  checkAgainstDeclared,
  encodeLaunch,
  type InputsCheck,
  inputHelp,
  LAUNCH_ENV,
  type LaunchInputs,
  type LaunchRequest,
  optionalLoopFields,
  parseInputFlags,
} from "../application/launch-inputs.ts";
import type { LoadError, LoadResult } from "../application/load-workflow.ts";
import {
  type OperatorErrorCode,
  renderOperatorConfirmation,
  renderOperatorFailure,
  renderOperatorFailureLines,
} from "../application/operator-error.ts";
import { decodeMessage, encodeMessage, PING } from "../application/owner-protocol.ts";
import { endedHelp, runEndFromStatus } from "../application/run-end.ts";
import { parseSource, type RemoteSource } from "../application/source.ts";
import { ownerGoneMessage } from "../application/tail.ts";
import type { Workflow } from "../domain/model.ts";
import { loadDirectory, loadInput, loadThinText } from "./directory-loader.ts";
import { classifyInput, type InputKind, readStdin } from "./input.ts";
import {
  attachMonitor,
  hasTerminal,
  type MonitorIo,
  type MonitorOptions,
  waitForRun,
} from "./monitor.ts";
import { ownerLogHelp } from "./owner-log.ts";
import { type FetchedRemote, fetchRemote, RemoteFetchError } from "./remote-fetch.ts";
import { createRunDirectory, loopfileHome, newRunId, type RunPaths } from "./run-directory.ts";
import {
  checkManifestVersion,
  checkManifestVersionText,
  type UpgradeIo,
} from "./upgrade-command.ts";

type Out = (text: string) => void;
type CheckIo = Pick<LaunchIo, "err" | "upgrade">;

const USAGE =
  "Usage: loopfile <directory|file.loop|github:owner/repo|-> [-d | --detach] [--trust] [--input <name>=<value>]...";
const HELP = `${USAGE}

Run a Loopfile in the background. The source may be a directory, a thin file,
a GitHub Remote Loopfile (github:owner/repo), or '-' for a manifest read from
stdin. Without --detach, a terminal attaches the
live monitor; press d to detach while the run continues. With --detach, print
the run ID and return immediately.

With no terminal and without --detach, there is no monitor: the command waits
for the run to end. The run ID goes to stdout and the confirmation or failure
goes to stderr. Exit codes are 0 when the run completes or is detached, 1 when
it fails or is cancelled, and 2 when it cannot start or the run owner crashes.
`;

/** How long the CLI waits for a run owner to say "ready", which includes making the workspace. */
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 50;
export interface LaunchIo {
  readonly out: Out;
  readonly err: Out;
  readonly upgrade: UpgradeIo;
  readonly monitor: MonitorIo;
}

/** Overridable for tests only. */
export interface LaunchOptions {
  readonly monitor?: MonitorOptions;
  readonly readyTimeoutMs?: number;
  /** The target repository. Left out means the current directory. */
  readonly repository?: string;
  /** Set by an in-process loop owner; there is no CLI flag. */
  readonly loopId?: string;
  readonly loopIndex?: number;
  /** How `loopfile -` supplies the manifest in tests and the CLI. */
  readonly readStdin?: () => Promise<Buffer>;
}

/**
 * Runs `argv`, which has no command name in it. `cli` is the path of the CLI
 * script the run owner is started from. Returns the exit code.
 */
export async function launchCommand(
  argv: readonly string[],
  cli: string,
  io: LaunchIo,
  env: Record<string, string | undefined>,
  options: LaunchOptions = {},
): Promise<number> {
  const args = parseLaunchArgs(argv);
  if (args === undefined) return refuse(io, USAGE, 2);
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  if (args.source === undefined) return refuse(io, USAGE, 2);

  const parsed = parseSource(args.source);
  if (parsed.kind === "local") {
    return await launchSource(args, parsed.source, undefined, undefined, cli, io, env, options);
  }
  return await launchRemote(args, parsed, cli, io, env, options);
}

async function launchSource(
  args: LaunchArgs,
  sourceName: string,
  loopfileName: string | undefined,
  remote: RemoteSource | undefined,
  cli: string,
  io: LaunchIo,
  env: Record<string, string | undefined>,
  options: LaunchOptions,
): Promise<number> {
  const source = await prepareLaunchSource(sourceName, io, options.readStdin ?? readStdin);
  if (!source.ok) return source.exitCode;

  const inputs = resolveInputs(args.inputs, source.workflow);
  if (!inputs.ok) {
    return refuse(io, inputs.messages, 2, "bad_argument", inputHelp(source.workflow.inputDefaults));
  }
  if (remote !== undefined && !args.trust) {
    return refuse(
      io,
      `untrusted Remote Loopfile ${remote.host}/${remote.repo}`,
      2,
      "untrusted",
      "Run it in a terminal to answer the trust prompt, or pass --trust to run it once.",
    );
  }

  const request: LaunchRequest = {
    source: sourceName,
    kind: source.kind,
    sourceText: source.text,
    repository: options.repository ?? process.cwd(),
    inputs: inputs.inputs,
    loopfileName,
    ...optionalLoopFields(options.loopId, options.loopIndex),
  };
  return await start(args.detach, request, source.workflow, cli, io, env, options);
}

async function launchRemote(
  args: LaunchArgs,
  remote: RemoteSource,
  cli: string,
  io: LaunchIo,
  env: Record<string, string | undefined>,
  options: LaunchOptions,
): Promise<number> {
  let fetched: FetchedRemote | undefined;
  try {
    try {
      fetched = await fetchRemote(remote, env);
    } catch (error) {
      const message = error instanceof RemoteFetchError ? error.message : (error as Error).message;
      return refuse(io, message, 2, "operation_failed");
    }
    return await launchSource(
      args,
      fetched.path,
      remote.repo.slice(remote.repo.lastIndexOf("/") + 1),
      remote,
      cli,
      io,
      env,
      options,
    );
  } finally {
    await fetched?.cleanup().catch(() => undefined);
  }
}

export type LaunchSource =
  | { readonly ok: true; readonly kind: InputKind; readonly text?: string }
  | { readonly ok: false; readonly exitCode: number };

export type PreparedLaunchSource =
  | (Extract<LaunchSource, { readonly ok: true }> & { readonly workflow: Workflow })
  | Extract<LaunchSource, { readonly ok: false }>;

/** Reads stdin once, because the detached owner cannot read the launcher's stdin. */
async function readLaunchSource(
  source: string,
  io: CheckIo,
  readInput: () => Promise<Buffer>,
): Promise<LaunchSource> {
  if (source === "-") {
    try {
      return { ok: true, kind: "thin", text: (await readInput()).toString("utf8") };
    } catch (error) {
      return {
        ok: false,
        exitCode: refuse(io, `cannot read stdin: ${(error as Error).message}`, 1),
      };
    }
  }
  try {
    return { ok: true, kind: await classifyInput(source) };
  } catch (error) {
    const missing = isMissingPath(error);
    const message = (error as Error).message;
    const text = missing ? `unknown command '${source}' (${message})` : message;
    return { ok: false, exitCode: refuse(io, text, missing ? 2 : 1) };
  }
}

export async function prepareLaunchSource(
  source: string,
  io: CheckIo,
  readInput: () => Promise<Buffer>,
): Promise<PreparedLaunchSource> {
  const input = await readLaunchSource(source, io, readInput);
  if (!input.ok) return input;

  const checked =
    input.text === undefined
      ? await checkManifestVersion(source, io.upgrade)
      : checkManifestVersionText(source, input.text, io.upgrade);
  if (!checked.ok) return { ok: false, exitCode: checked.exitCode };

  const workflow = await loadWorkflow(source, input.kind, io, input.text);
  return workflow === undefined ? { ok: false, exitCode: 1 } : { ...input, workflow };
}

function isMissingPath(error: unknown): boolean {
  const cause = (error as Error).cause as NodeJS.ErrnoException | undefined;
  return cause?.code === "ENOENT";
}

export function resolveInputs(flags: readonly string[], workflow: Workflow): InputsCheck {
  const given = parseInputFlags(flags);
  return given.ok
    ? checkAgainstDeclared(given.inputs, workflow.inputs, workflow.inputDefaults)
    : given;
}

interface LaunchArgs {
  readonly source: string | undefined;
  readonly detach: boolean;
  readonly inputs: readonly string[];
  readonly help: boolean;
  readonly trust: boolean;
}

function parseLaunchArgs(argv: readonly string[]): LaunchArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        detach: { type: "boolean", short: "d" },
        help: { type: "boolean", short: "h" },
        input: { type: "string", multiple: true },
        trust: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const [source] = positionals;
    if (positionals.length > 1) return undefined;
    if (source === undefined && values.help !== true) return undefined;
    return {
      source,
      detach: values.detach === true,
      inputs: values.input ?? [],
      help: values.help === true,
      trust: values.trust === true,
    };
  } catch {
    return undefined;
  }
}

function refuse(
  io: Pick<LaunchIo, "err">,
  message: string | readonly string[],
  exitCode: 1 | 2,
  code: OperatorErrorCode = "bad_argument",
  help = USAGE,
): number {
  const messages = typeof message === "string" ? [message] : message;
  io.err(renderOperatorFailureLines(messages, code, help, exitCode).stderr);
  return exitCode;
}

/** Loads the source as it would be run, and prints what is wrong when it does not load. */
async function loadWorkflow(
  source: string,
  kind: InputKind,
  io: CheckIo,
  text?: string,
): Promise<Workflow | undefined> {
  let result: LoadResult;
  try {
    result = text === undefined ? await loadInput(source, kind) : loadThinText(text, source);
  } catch (error) {
    refuse(io, (error as Error).message, 1, "operation_failed");
    return undefined;
  }
  if (result.status === "loaded") return result.workflow;
  refuseLoadResult(source, result, io);
  return undefined;
}

function refuseLoadResult(
  source: string,
  result: Exclude<LoadResult, { readonly status: "loaded" }>,
  io: CheckIo,
): void {
  if (result.status === "older") {
    refuse(
      io,
      `manifest formatVersion ${result.formatVersion} is outdated`,
      2,
      "operation_failed",
      `Run: loopfile upgrade ${source}`,
    );
    return;
  }
  const messages = manifestErrorMessages(result.errors);
  io.err(
    renderOperatorFailureLines(
      messages,
      "invalid_manifest",
      "Fix the manifest before launching.",
      1,
    ).stderr,
  );
}

async function start(
  detach: boolean,
  request: LaunchRequest,
  workflow: Workflow,
  cli: string,
  io: LaunchIo,
  env: Record<string, string | undefined>,
  options: LaunchOptions,
): Promise<number> {
  const started = await startRun({
    source: request.source,
    sourceKind: request.kind,
    sourceText: request.sourceText,
    workflow,
    repository: request.repository,
    inputs: request.inputs,
    runId: newRunId(),
    loopId: request.loopId,
    loopIndex: request.loopIndex,
    loopfileName: request.loopfileName,
    cli,
    env,
    readyTimeoutMs: options.readyTimeoutMs,
  });
  if (!started.ok) return refuseStart(io, started.failure);
  return await continueAfterReady(started.runId, detach, "started", io, env, options);
}

/** The detached start seam used by `loopfile <source>` and loop owners. */
export interface StartRunOptions {
  /** A Materialized Loopfile folder, or a launch source when `workflow` is given. */
  readonly source: string;
  readonly sourceKind?: InputKind;
  readonly sourceText?: string;
  readonly workflow?: Workflow;
  readonly repository: string;
  readonly inputs: LaunchInputs;
  readonly runId: string;
  readonly loopId?: string;
  readonly loopIndex?: number;
  readonly loopfileName?: string;
  /** The CLI script used to start the detached run owner. */
  readonly cli: string;
  readonly env: Record<string, string | undefined>;
  /** Overridable for tests only. */
  readonly readyTimeoutMs?: number;
}

export interface StartRunFailure {
  readonly messages: readonly string[];
  readonly code: OperatorErrorCode;
  readonly help: string;
  readonly exitCode: 1 | 2;
}

export type StartRunResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly failure: StartRunFailure };

/** Makes a run folder, starts its detached owner and waits for the ready handshake. */
export async function startRun(options: StartRunOptions): Promise<StartRunResult> {
  const workflow = await workflowForStart(options);
  if (!workflow.ok) return workflow;

  const inputs = checkAgainstDeclared(
    options.inputs,
    workflow.workflow.inputs,
    workflow.workflow.inputDefaults,
  );
  if (!inputs.ok) {
    return {
      ok: false,
      failure: startFailure(
        inputs.messages,
        "bad_argument",
        inputHelp(workflow.workflow.inputDefaults),
        2,
      ),
    };
  }

  const home = loopfileHome(options.env as NodeJS.ProcessEnv);
  let paths: RunPaths;
  try {
    paths = await createRunDirectory({
      home,
      runId: options.runId,
      targetRepository: options.repository,
      stepIds: workflow.workflow.steps.map((step) => step.id),
    });
  } catch (error) {
    return {
      ok: false,
      failure: startFailure((error as Error).message, "operation_failed", USAGE, 1),
    };
  }

  const request: LaunchRequest = {
    source: options.source,
    kind: options.sourceKind ?? "directory",
    ...(options.sourceText === undefined ? {} : { sourceText: options.sourceText }),
    repository: options.repository,
    inputs: inputs.inputs,
    loopfileName: options.loopfileName,
    ...optionalLoopFields(options.loopId, options.loopIndex),
  };
  return await startDetachedOwner({
    ownerId: options.runId,
    paths,
    ownerEnv: { ...options.env, [LAUNCH_ENV]: encodeLaunch(request) },
    cli: options.cli,
    ownerCommand: "__owner",
    ownerKind: "run",
    readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
  });
}

async function workflowForStart(
  options: StartRunOptions,
): Promise<
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly failure: StartRunFailure }
> {
  if (options.workflow !== undefined) return { ok: true, workflow: options.workflow };
  try {
    const loaded = await loadDirectory(options.source);
    if (loaded.status === "loaded") return { ok: true, workflow: loaded.workflow };
    if (loaded.status === "older") {
      return {
        ok: false,
        failure: startFailure(
          `manifest formatVersion ${loaded.formatVersion} is outdated`,
          "operation_failed",
          `Run: loopfile upgrade ${options.source}`,
          2,
        ),
      };
    }
    return {
      ok: false,
      failure: startFailure(
        manifestErrorMessages(loaded.errors),
        "invalid_manifest",
        "Fix the manifest before launching.",
        1,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      failure: startFailure((error as Error).message, "operation_failed", USAGE, 1),
    };
  }
}

function manifestErrorMessages(errors: readonly LoadError[]): readonly string[] {
  return errors.map((error) => {
    const where = error.line === undefined ? "" : `line ${error.line}: `;
    return `${where}${error.path === "" ? "" : `${error.path}: `}${error.message}`;
  });
}

function startFailure(
  messages: string | readonly string[],
  code: OperatorErrorCode,
  help: string,
  exitCode: 1 | 2,
): StartRunFailure {
  return { messages: typeof messages === "string" ? [messages] : messages, code, help, exitCode };
}

function refuseStart(io: LaunchIo, failure: StartRunFailure): number {
  io.err(
    renderOperatorFailureLines(failure.messages, failure.code, failure.help, failure.exitCode)
      .stderr,
  );
  return failure.exitCode;
}

/** What `startOwner` starts, and how the CLI goes on once it is ready. */
export interface OwnerStart {
  readonly runId: string;
  readonly paths: RunPaths;
  /** The run owner's whole environment, with what it is to do. */
  readonly ownerEnv: Record<string, string | undefined>;
  readonly detach: boolean;
  /** The confirmation fact printed after the owner is ready. */
  readonly confirmation: "started" | "resumed";
  /** The CLI script the run owner is started from. */
  readonly cli: string;
}

/**
 * Starts the run owner in its own session and waits for its "ready" (ADR
 * 0008). Then it prints the run ID and returns (`-d`), attaches the monitor, or
 * with no terminal waits for the end and reports it (#184).
 * A new run and a resume start their run owner the same way (#64).
 */
export async function startOwner(
  { runId, paths, ownerEnv, detach, confirmation, cli }: OwnerStart,
  io: Pick<LaunchIo, "out" | "err" | "monitor">,
  env: Record<string, string | undefined>,
  options: LaunchOptions,
): Promise<number> {
  const started = await startDetachedOwner({
    ownerId: runId,
    paths,
    ownerEnv,
    cli,
    ownerCommand: "__owner",
    ownerKind: "run",
    readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
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
  return await continueAfterReady(started.runId, detach, confirmation, io, env, options);
}

export interface DetachedOwnerStart {
  readonly ownerId: string;
  readonly paths: Pick<RunPaths, "socket" | "ownerLog">;
  readonly ownerEnv: Record<string, string | undefined>;
  readonly cli: string;
  readonly ownerCommand: "__owner" | "__loop-owner";
  readonly ownerKind: "run" | "loop";
  readonly readyTimeoutMs: number;
}

export async function startDetachedOwner(options: DetachedOwnerStart): Promise<StartRunResult> {
  let owner: ChildProcess;
  try {
    owner = spawnOwner(
      options.cli,
      options.ownerCommand,
      options.ownerId,
      options.paths.ownerLog,
      options.ownerEnv,
    );
  } catch (error) {
    return {
      ok: false,
      failure: startFailure(
        (error as Error).message,
        "operation_failed",
        await ownerLogHelp(options.paths.ownerLog),
        2,
      ),
    };
  }

  const ready = await waitForReady(
    owner,
    options.paths.socket,
    options.ownerId,
    options.readyTimeoutMs,
  );
  if (ready !== "ready") {
    if (ready === "timeout") owner.kill("SIGTERM");
    return {
      ok: false,
      failure: await failedStart(options.paths.ownerLog, options.ownerId, ready, options.ownerKind),
    };
  }
  owner.unref();
  return { ok: true, runId: options.ownerId };
}

async function continueAfterReady(
  runId: string,
  detach: boolean,
  confirmation: "started" | "resumed",
  io: Pick<LaunchIo, "out" | "err" | "monitor">,
  env: Record<string, string | undefined>,
  options: LaunchOptions,
): Promise<number> {
  io.out(`${runId}\n`);
  io.err(renderOperatorConfirmation({ [confirmation]: runId }));

  if (detach) return 0;
  if (hasTerminal(io.monitor)) return await attachMonitor(runId, io.monitor, env, options.monitor);
  return await reportEnd(runId, io, env, options);
}

/** With no terminal: wait with no screen, then report the run on stderr. */
async function reportEnd(
  runId: string,
  io: Pick<LaunchIo, "out" | "err">,
  env: Record<string, string | undefined>,
  options: LaunchOptions,
): Promise<number> {
  const { view, exit } = await waitForRun(runId, env, options.monitor);
  if (view.kind === "ended") {
    const end = runEndFromStatus(view.status);
    if (end.state === "completed") {
      io.err(renderOperatorConfirmation({ ended: `${end.runId} ${end.state}` }));
    } else {
      io.err(
        renderOperatorFailure(
          {
            summary: `run ${end.runId} ${end.state}: ${end.endReason ?? "unknown"}${
              end.stepId === null ? "" : ` at step "${end.stepId}"`
            }`,
            code: "operation_failed",
            help: endedHelp(end).trim(),
          },
          1,
        ).stderr,
      );
    }
  } else {
    io.err(
      renderOperatorFailure(
        {
          summary: ownerGoneMessage(runId),
          code: "owner_gone",
          help: `Resume the crashed run with: loopfile resume ${runId}`,
        },
        2,
      ).stderr,
    );
  }
  return exit;
}

/** The run owner, in its own session, with stdin ignored and stdout and stderr in `owner.log`. */
function spawnOwner(
  cli: string,
  command: "__owner" | "__loop-owner",
  ownerId: string,
  ownerLog: string,
  env: Record<string, string | undefined>,
): ChildProcess {
  const log = openSync(ownerLog, "a");
  try {
    return spawn(process.execPath, [cli, command, ownerId], {
      detached: true,
      stdio: ["ignore", log, log],
      env,
    });
  } finally {
    closeSync(log);
  }
}

type Waited = "ready" | "exited" | "timeout";

/** Resolves when the run owner answers "ready" on its control socket, exits, or the wait runs out. */
function waitForReady(
  owner: ChildProcess,
  socketPath: string,
  runId: string,
  timeoutMs: number,
): Promise<Waited> {
  return new Promise<Waited>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Waited): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A run owner exits 0 only after it said "ready" and ran the run to its end.
    // A short run can do all of that between two polls, and it did start.
    owner.once("exit", (code) => finish(code === 0 ? "ready" : "exited"));
    owner.once("error", () => finish("exited"));
    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<void> => {
      if (settled) return;
      if (await askReady(socketPath, runId)) return finish("ready");
      if (Date.now() >= deadline) return finish("timeout");
      timer = setTimeout(() => void poll(), READY_POLL_MS);
    };
    void poll();
  });
}

/** One connection to the control socket: true when it greets with "ready" for `runId`. */
function askReady(socketPath: string, runId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    let pending = "";
    const done = (ready: boolean): void => {
      socket.destroy();
      resolve(ready);
    };
    socket.on("connect", () => socket.write(encodeMessage({ type: PING })));
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const message = decodeMessage(line);
        if (message?.type === "ready" && message.runId === runId) return done(true);
      }
    });
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
  });
}

async function failedStart(
  ownerLog: string,
  ownerId: string,
  waited: Waited,
  ownerKind: "run" | "loop",
): Promise<StartRunFailure> {
  const why = waited === "timeout" ? "did not say ready in time" : "exited before it was ready";
  return startFailure(
    `the ${ownerKind} owner for ${ownerId} ${why}`,
    "operation_failed",
    await ownerLogHelp(ownerLog),
    2,
  );
}
