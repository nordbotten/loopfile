/**
 * `loopfile status [<runid>] [--monitor | --json]` (#36).
 *
 * Read-only. It reads `status.json` and `events.jsonl`, and pings
 * `owner.sock` (ADR 0008), through the same `discoverRun` and `discoverRuns`
 * that `list` uses, so the two never disagree about crashed or unknown. It
 * never writes a run file.
 *
 * Bare `status` needs a terminal: it lists the runs and asks for a number.
 * Then, with or without a run ID, it prints the run once, or attaches the
 * monitor (#49) with `--monitor`. `--json` output is one JSON line with no ANSI.
 */

import { createInterface } from "node:readline/promises";
import { notTerminalMessage } from "../application/monitor.ts";
import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { NO_RUNS_MESSAGE } from "../application/run-list.ts";
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
import { attachMonitor, hasTerminal, type MonitorIo, type MonitorOptions } from "./monitor.ts";
import { loopfileHome, pathExists, runPaths } from "./run-directory.ts";
import {
  type DiscoverRunsOptions,
  discoverRun,
  discoverRuns,
  EventLogReadError,
  eventLogFailure,
  readEventLog,
} from "./run-discovery.ts";

type Out = (text: string) => void;
type Err = (text: string) => void;
type Discovered = Awaited<ReturnType<typeof discoverRun>>;

const HELP = `Usage: loopfile status [<runid>] [--monitor | --json]

Show one run. With no run ID, a terminal lists runs and lets you pick one;
without a terminal use loopfile list, then status <runid>. Use --monitor to
attach the live monitor instead of printing once, and --json with a run ID for
one structured answer. Status describes a run and returns 0 for a readable
result or 2 for a bad or unreadable call.
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
    const picked = await pickRun(io, processEnv, err, options);
    if (typeof picked === "number") return picked;
    runId = picked;
  }

  if (args.monitor) return await monitorRun(runId, io, processEnv, err, options);
  return await printRun(runId, args.json, out, err, processEnv, options);
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

/** The picked run ID, or the exit code when there is nothing to pick. */
async function pickRun(
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
  try {
    entries = await discoverRuns(env, options);
  } catch (error) {
    const runId = error instanceof EventLogReadError ? error.runId : undefined;
    return fail(err, eventLogFailure(error, runId));
  }
  if (entries.length === 0) {
    io.output.write(NO_RUNS_MESSAGE);
    return 0;
  }

  io.output.write(`${renderPicker(entries, true)}\n`);
  const runId = await askForRun(
    io,
    entries.map((entry) => entry.runId),
  );
  return runId ?? 0;
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

/** Asks until the answer names a run. `undefined` on `q` or when input ends. */
async function askForRun(io: MonitorIo, runIds: readonly string[]): Promise<string | undefined> {
  const rl = createInterface({ input: io.input, output: io.output });
  // A pending `question` never settles when input ends, so race it with `close`.
  const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("q")));
  try {
    for (;;) {
      const answer = await Promise.race([
        rl.question("Pick a run by number (q to quit): "),
        closed,
      ]);
      const pick = parsePick(answer, runIds.length);
      if (pick === "quit") return undefined;
      if (pick !== undefined) return runIds[pick];
    }
  } finally {
    rl.close();
  }
}

function fail(err: Err, failure: OperatorFailure): 2 {
  err(renderOperatorFailure(failure).stderr);
  return 2;
}
