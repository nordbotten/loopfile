/**
 * `loopfile status [<runid>|<loopid>] [--monitor | --json]` (#36, #71).
 *
 * Read-only. It reads `status.json` and `events.jsonl`, and pings
 * `owner.sock` (ADR 0008), through the same discovery adapters that `list`
 * uses, so the two never disagree about crashed or unknown. It never writes a
 * run file.
 *
 * Bare `status` needs a terminal: it lists loops and runs and asks for a number.
 * Then, with or without an ID, it prints the selected run or loop once, or
 * attaches the monitor (#49) with `--monitor`. `--json` output is one JSON line with no ANSI.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  buildLoopStatusView,
  type LoopRunStatusView,
  renderLoopStatusView,
} from "../application/loop-status-view.ts";
import { notTerminalMessage } from "../application/monitor.ts";
import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { deriveLoopListEntry, isLoopId, NO_RUNS_MESSAGE } from "../application/run-list.ts";
import {
  buildStatusView,
  notTerminalStatusMessage,
  parsePick,
  parseStatusArgs,
  recentTransitions,
  renderPicker,
  renderStatusView,
  unreadableStatusMessage,
} from "../application/status-view.ts";
import { unknownRunMessage } from "../application/tail.ts";
import type { LoopEvent } from "../domain/events.ts";
import type { LoopStatus } from "../domain/status.ts";
import { discoverLoops } from "./loop-discovery.ts";
import { attachMonitor, hasTerminal, type MonitorIo, type MonitorOptions } from "./monitor.ts";
import { loopfileHome, loopPaths, pathExists, runPaths } from "./run-directory.ts";
import {
  type DiscoverRunsOptions,
  discoverRun,
  discoverRuns,
  EventLogReadError,
  eventLogFailure,
  readEventLog,
} from "./run-discovery.ts";
import { pingOwner } from "./run-owner.ts";

type Out = (text: string) => void;
type Err = (text: string) => void;
type Discovered = Awaited<ReturnType<typeof discoverRun>>;

const HELP = `Usage: loopfile status [<runid>|<loopid>] [--monitor | --json]

Show one run or loop. With no ID, a terminal lists loops and runs and lets you
pick one; without a terminal use loopfile list, then status <runid> or status <loopid>.
Use --monitor for a run's live view, and --json for one structured answer.
Status returns 0 for a readable result or 2 for a bad or unreadable call.
`;

type ReadStatus = {
  readonly entry: Discovered["entry"];
  readonly status: NonNullable<Discovered["status"]>;
  readonly events: Awaited<ReturnType<typeof readEventLog>>;
};

/** Overridable for tests only. */
export interface StatusOptions extends DiscoverRunsOptions {
  readonly io?: MonitorIo;
  readonly monitor?: MonitorOptions;
}

/** Runs `status`. Returns the process exit code. */
export async function statusCommand(
  argv: readonly string[],
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
  options: StatusOptions = {},
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const args = parseStatusArgs(argv);
  if (!args.ok)
    return fail(err, {
      summary: args.message,
      code: "bad_argument",
      help: "Use `loopfile status <runid>` or `loopfile list`.",
    });
  const processEnv = env as NodeJS.ProcessEnv;
  const io = options.io ?? { input: process.stdin, output: process.stdout };

  let runId = args.runId;
  if (runId === undefined) {
    const picked = await pickId(io, processEnv, err, options);
    if (typeof picked === "number") return picked;
    runId = picked;
  }

  return await statusById(runId, args.json, args.monitor, io, out, err, processEnv, options);
}

async function statusById(
  runId: string,
  json: boolean,
  monitor: boolean,
  io: MonitorIo,
  out: Out,
  err: Err,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<number> {
  if (isLoopId(runId)) return await loopStatusById(runId, json, monitor, out, err, env, options);
  return monitor
    ? await monitorRun(runId, io, env, err, options)
    : await printRun(runId, json, out, err, env, options);
}

async function loopStatusById(
  loopId: string,
  json: boolean,
  monitor: boolean,
  out: Out,
  err: Err,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<number> {
  if (monitor) {
    return fail(err, {
      summary: "loop status does not support --monitor",
      code: "bad_argument",
      help: "Use `loopfile status <loopid>` or `loopfile status <loopid> --json`.",
    });
  }
  return await printLoop(loopId, json, out, err, env, options);
}

/** Prints the run once, as text or as one JSON line. */
async function printRun(
  runId: string,
  json: boolean,
  out: Out,
  err: Err,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<number> {
  const read = await readStatusForCommand(runId, env, options);
  if ("code" in read) return fail(err, read);

  const view = buildStatusView(read.status, read.entry.state, recentTransitions(read.events));
  out(json ? `${JSON.stringify(view)}\n` : renderStatusView(view));
  return 0;
}

async function printLoop(
  loopId: string,
  json: boolean,
  out: Out,
  err: Err,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<number> {
  const read = await readLoopForCommand(loopId, env);
  if ("code" in read) return fail(err, read);

  const state = await derivedLoopState(read.status, env, options);
  const observed = await observeLoopRuns(read.runs, env, options);
  const view = buildLoopStatusView(
    read.status,
    state,
    observed.map(({ run }) => run),
  );
  const currentStep = observed.find(
    ({ run }) => run.runId === read.status.currentRunId && run.state === "running",
  )?.step;
  out(json ? `${JSON.stringify(view)}\n` : renderLoopStatusView(view, currentStep ?? null));
  return 0;
}

type LoopRunStarted = Extract<LoopEvent, { readonly type: "loop.run_started" }>;
type ObservedLoopRun = {
  readonly run: LoopRunStatusView;
  readonly step: string | null;
};

async function derivedLoopState(
  status: LoopStatus,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
) {
  const alive =
    status.state !== "running" ||
    (await pingLoopOwner(status.loopId, env, options.pingTimeoutMs)) === status.loopId;
  return deriveLoopListEntry({
    status,
    alive,
    now: (options.now?.() ?? new Date()).toISOString(),
  }).state;
}

async function observeLoopRuns(
  runs: readonly LoopRunStarted[],
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<readonly ObservedLoopRun[]> {
  return await Promise.all(runs.map((run) => observeLoopRun(run, env, options)));
}

async function observeLoopRun(
  started: LoopRunStarted,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<ObservedLoopRun> {
  const child = await discoverRun(started.runId, env, options);
  return {
    run: {
      index: started.index,
      runId: started.runId,
      inputSet: started.inputSet,
      retryOf: started.retryOf,
      state: child.entry.state,
      elapsedMs: child.entry.elapsedMs,
      metrics: child.status?.metrics ?? null,
    },
    step: child.entry.state === "running" ? (child.status?.current?.stepId ?? null) : null,
  };
}

type ReadLoop = {
  readonly status: LoopStatus;
  readonly runs: readonly LoopRunStarted[];
};

async function readLoopForCommand(
  loopId: string,
  env: NodeJS.ProcessEnv,
): Promise<ReadLoop | OperatorFailure> {
  const paths = loopPaths(loopfileHome(env), loopId);
  if (!(await pathExists(paths.root))) {
    return {
      summary: `loop ${loopId} does not exist`,
      code: "no_such_loop",
      help: "Use `loopfile list` to find a valid loop ID.",
    };
  }

  let status: LoopStatus;
  try {
    status = JSON.parse(await readFile(paths.status, "utf8")) as LoopStatus;
  } catch (error) {
    return {
      summary: `loop ${loopId} has no readable status.json${error instanceof Error ? `: ${error.message}` : ""}`,
      code: "log_unreadable",
      help: "Check the loop folder and its status.json.",
    };
  }

  let events: readonly LoopEvent[];
  try {
    events = (await readEventLog(paths.events, loopId)) as readonly LoopEvent[];
  } catch (error) {
    return eventLogFailure(error, loopId);
  }
  const runs = events.filter((event): event is LoopRunStarted => event.type === "loop.run_started");
  return { status, runs };
}

async function pingLoopOwner(
  loopId: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number | undefined,
): Promise<string | undefined> {
  return await pingOwner(loopPaths(loopfileHome(env), loopId).socket, timeoutMs);
}

async function readStatusForCommand(
  runId: string,
  env: NodeJS.ProcessEnv,
  options: StatusOptions,
): Promise<ReadStatus | OperatorFailure> {
  const paths = runPaths(loopfileHome(env), runId);
  if (!(await pathExists(paths.root))) {
    return {
      summary: unknownRunMessage(runId),
      code: "no_such_run",
      help: "Use `loopfile list` to find a valid run ID.",
    };
  }

  let events: ReadStatus["events"];
  try {
    events = await readEventLog(paths.events, runId);
  } catch (error) {
    return eventLogFailure(error, runId);
  }
  const discovered = await discoverRun(runId, env, options);
  if (discovered.status === undefined) {
    return {
      summary: unreadableStatusMessage(runId),
      code: "log_unreadable",
      help: "Check the run folder and its status.json.",
    };
  }
  return { entry: discovered.entry, status: discovered.status, events };
}

/** The picked run or loop ID, or the exit code when there is nothing to pick. */
async function pickId(
  io: MonitorIo,
  env: NodeJS.ProcessEnv,
  err: Err,
  options: StatusOptions,
): Promise<string | number> {
  if (!hasTerminal(io)) {
    return fail(err, {
      summary: notTerminalStatusMessage(),
      code: "no_terminal",
      help: "Use `loopfile list` to find a run, then `loopfile status <runid>`.",
    });
  }
  let entries: Awaited<ReturnType<typeof discoverRuns>>;
  let loops: Awaited<ReturnType<typeof discoverLoops>>;
  try {
    [entries, loops] = await Promise.all([discoverRuns(env, options), discoverLoops(env, options)]);
  } catch (error) {
    const runId = error instanceof EventLogReadError ? error.runId : undefined;
    return fail(err, eventLogFailure(error, runId));
  }
  if (entries.length === 0 && loops.length === 0) {
    io.output.write(NO_RUNS_MESSAGE);
    return 0;
  }

  io.output.write(`${renderPicker(entries, true, loops)}\n`);
  const ids = [...loops.map((entry) => entry.loopId), ...entries.map((entry) => entry.runId)];
  const id = await askForId(io, ids);
  return id ?? 0;
}

async function monitorRun(
  runId: string,
  io: MonitorIo,
  env: NodeJS.ProcessEnv,
  err: Err,
  options: StatusOptions,
): Promise<number> {
  if (!hasTerminal(io)) {
    return fail(err, {
      summary: notTerminalMessage(runId),
      code: "no_terminal",
      help: `Drop --monitor: \`loopfile status ${runId}\` prints the run once.`,
    });
  }
  let readFailed = false;
  await attachMonitor(runId, io, env, {
    ...options.monitor,
    onReadError: (failure) => {
      readFailed = true;
      fail(err, failure);
    },
  });
  return readFailed ? 2 : 0;
}

/** Asks until the answer names a loop or run. `undefined` on q or input end. */
async function askForId(io: MonitorIo, ids: readonly string[]): Promise<string | undefined> {
  const rl = createInterface({ input: io.input, output: io.output });
  // A pending `question` never settles when input ends, so race it with `close`.
  const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("q")));
  try {
    for (;;) {
      const answer = await Promise.race([
        rl.question("Pick a run by number (q to quit): "),
        closed,
      ]);
      const pick = parsePick(answer, ids.length);
      if (pick === "quit") return undefined;
      if (pick !== undefined) return ids[pick];
    }
  } finally {
    rl.close();
  }
}

function fail(err: Err, failure: OperatorFailure): 2 {
  err(renderOperatorFailure(failure).stderr);
  return 2;
}
