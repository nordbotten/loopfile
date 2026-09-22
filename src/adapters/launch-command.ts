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
  optionalLoopFields,
  type InputsCheck,
  inputHelp,
  LAUNCH_ENV,
  type LaunchRequest,
  parseInputFlags,
} from "../application/launch-inputs.ts";
import type { LoadResult } from "../application/load-workflow.ts";
import {
  renderOperatorConfirmation,
  renderOperatorFailure,
  renderOperatorFailureLines,
} from "../application/operator-error.ts";
import { decodeMessage, encodeMessage, PING } from "../application/owner-protocol.ts";
import { endedHelp, runEndFromStatus } from "../application/run-end.ts";
import { ownerGoneMessage } from "../application/tail.ts";
import type { Workflow } from "../domain/model.ts";
import { loadInput, loadThinText } from "./directory-loader.ts";
import { classifyInput, type InputKind, readStdin } from "./input.ts";
import {
  attachMonitor,
  hasTerminal,
  type MonitorIo,
  type MonitorOptions,
  waitForRun,
} from "./monitor.ts";
import { ownerLogHelp } from "./owner-log.ts";
import { createRunDirectory, loopfileHome, newRunId, type RunPaths } from "./run-directory.ts";
import {
  checkManifestVersion,
  checkManifestVersionText,
  type UpgradeIo,
} from "./upgrade-command.ts";

type Out = (text: string) => void;

const USAGE = "Usage: loopfile <directory|file.loop|-> [-d | --detach] [--input <name>=<value>]...";
const HELP = `${USAGE}

Run a Loopfile in the background. The source may be a directory, a thin file,
or '-' for a manifest read from stdin. Without --detach, a terminal attaches the
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

  const source = await prepareLaunchSource(args.source, io, options.readStdin ?? readStdin);
  if (!source.ok) return source.exitCode;

  const inputs = resolveInputs(args.inputs, source.workflow);
  if (!inputs.ok) {
    return refuse(io, inputs.messages, 2, "bad_argument", inputHelp(source.workflow.inputDefaults));
  }

  const request: LaunchRequest = {
    source: args.source,
    kind: source.kind,
    sourceText: source.text,
    repository: options.repository ?? process.cwd(),
    inputs: inputs.inputs,
    ...optionalLoopFields(options.loopId, options.loopIndex),
  };
  return await start(args.detach, request, source.workflow, cli, io, env, options);
}

type LaunchSource =
  | { readonly ok: true; readonly kind: InputKind; readonly text?: string }
  | { readonly ok: false; readonly exitCode: number };

type PreparedLaunchSource =
  | (Extract<LaunchSource, { readonly ok: true }> & { readonly workflow: Workflow })
  | Extract<LaunchSource, { readonly ok: false }>;

/** Reads stdin once, because the detached owner cannot read the launcher's stdin. */
async function readLaunchSource(
  source: string,
  io: LaunchIo,
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

async function prepareLaunchSource(
  source: string,
  io: LaunchIo,
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

function resolveInputs(flags: readonly string[], workflow: Workflow): InputsCheck {
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
}

function parseLaunchArgs(argv: readonly string[]): LaunchArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        detach: { type: "boolean", short: "d" },
        help: { type: "boolean", short: "h" },
        input: { type: "string", multiple: true },
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
    };
  } catch {
    return undefined;
  }
}

function refuse(
  io: LaunchIo,
  message: string | readonly string[],
  exitCode: 1 | 2,
  code: "bad_argument" | "invalid_manifest" | "operation_failed" = "bad_argument",
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
  io: LaunchIo,
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
  io: LaunchIo,
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
  const messages = result.errors.map((error) => {
    const where = error.line === undefined ? "" : `line ${error.line}: `;
    return `${where}${error.path === "" ? "" : `${error.path}: `}${error.message}`;
  });
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
  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const runId = newRunId();
  let paths: RunPaths;
  try {
    paths = await createRunDirectory({
      home,
      runId,
      targetRepository: request.repository,
      stepIds: workflow.steps.map((step) => step.id),
    });
  } catch (error) {
    return refuse(io, (error as Error).message, 1, "operation_failed");
  }
  const ownerEnv = { ...env, [LAUNCH_ENV]: encodeLaunch(request) };
  return await startOwner(
    { runId, paths, ownerEnv, detach, cli, confirmation: "started" },
    io,
    env,
    options,
  );
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
  const owner = spawnOwner(cli, runId, paths.ownerLog, ownerEnv);
  const ready = await waitForReady(
    owner,
    paths.socket,
    runId,
    options.readyTimeoutMs ?? READY_TIMEOUT_MS,
  );
  if (ready !== "ready") {
    if (ready === "timeout") owner.kill("SIGTERM");
    const failure = await failedStart(paths.ownerLog, runId, ready);
    io.err(renderOperatorFailure(failure, 2).stderr);
    return 2;
  }
  owner.unref();
  io.out(`${runId}\n`);
  io.err(renderOperatorConfirmation({ [confirmation]: runId }));

  if (detach) {
    return 0;
  }
  if (hasTerminal(io.monitor)) {
    return await attachMonitor(runId, io.monitor, env, options.monitor);
  }
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
  runId: string,
  ownerLog: string,
  env: Record<string, string | undefined>,
): ChildProcess {
  const log = openSync(ownerLog, "a");
  try {
    return spawn(process.execPath, [cli, "__owner", runId], {
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
  runId: string,
  waited: Waited,
): Promise<{ readonly summary: string; readonly code: "operation_failed"; readonly help: string }> {
  const why = waited === "timeout" ? "did not say ready in time" : "exited before it was ready";
  return {
    summary: `the run owner for ${runId} ${why}`,
    code: "operation_failed",
    help: await ownerLogHelp(ownerLog),
  };
}
