/**
 * `loopfile tail <runid>`: prints the last lines of a run's `activity.log`
 * and follows new ones, like `tail -f` (#51).
 *
 * A read-only view of the run folder (#14) and the activity log (#50, ADR
 * 0007). It never reads `status.json`, never reads attempt output (#37), and
 * never writes a run file: it polls `activity.log` and `events.jsonl` for new
 * bytes and pings the control socket the same way `startRunOwner` does (ADR
 * 0008), and stops the moment either says to. It never replays `events.jsonl`
 * into run state — `application/tail.ts` only ever looks for one end event
 * line at a time.
 *
 * With `--json` (#186) it prints the lines of `events.jsonl` instead, all of
 * them from the first, each exactly as the run owner wrote it and only once it
 * is whole, up to and including the end event. The activity log is still read
 * the same way, it just goes nowhere, so both modes share one follow loop.
 *
 * Everything a human reads that is not a log line — the "unknown run",
 * "no activity log yet" and "run owner is gone" messages, and the end text a
 * run that did not complete gets — goes to stderr, so a supervising script
 * can pipe `stdout` and get activity lines only.
 *
 * The exit code tells that script how the run ended, the same 0/1/2 the
 * monitor and `loopfile <source>` give (#184, #185): 0 the run completed, 1
 * it failed or was cancelled, 2 a Loopfile problem — an unknown run, no
 * activity log, or a run owner that is gone with no end event. The end itself
 * is read off the end event `tail` was already watching for, not from
 * `status.json`: the run owner writes the event first, so a reader that
 * stopped on the event can be ahead of the file.
 */

import { open, readFile } from "node:fs/promises";
import { type OperatorFailure, renderOperatorFailure } from "../application/operator-error.ts";
import { endedExitCode, endedHelp, type RunEnd } from "../application/run-end.ts";
import { isLoopId } from "../application/run-list.ts";
import {
  missingActivityLogMessage,
  ownerGoneMessage,
  parseTailArgs,
  splitCompleteLines,
  TAIL_LINE_COUNT,
  throughEnd,
  unknownRunMessage,
} from "../application/tail.ts";
import { LOOP_EVENT_TYPES } from "../domain/events.ts";
import { ownerLogHelp } from "./owner-log.ts";
import {
  type LoopPaths,
  loopfileHome,
  loopPaths,
  pathExists,
  type RunPaths,
  runPaths,
} from "./run-directory.ts";
import { pingOwner } from "./run-owner.ts";

type Out = (text: string) => void;
type Err = (text: string) => void;

/** Where each file's whole lines go: stdout for the one `tail` prints, nowhere for the other. */
interface Sinks {
  readonly activity: Out;
  readonly events: Out;
}

const discard: Out = () => {};
const HELP = `Usage: loopfile tail <runid|loopid> [--json]

Print the last activity lines and follow the run until it ends. A loop ID follows
all of its child runs. Activity lines
go to stdout only. With --json, print events from events.jsonl instead, one
JSON object per line. Exit codes are 0 for a completed run, 1 for a failed or
cancelled run, and 2 for an unknown or otherwise unreadable run.
`;

/** How often `tail` re-reads the files and pings the run owner while following. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** Overridable for tests only. */
export interface TailOptions {
  readonly pollIntervalMs?: number;
  readonly ownerPingTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Runs `tail`. Returns the process exit code. */
export async function tailCommand(
  argv: readonly string[],
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
  options: TailOptions = {},
): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const args = parseTailArgs(argv);
  if (!args.ok) return fail(err, args.message);

  try {
    const home = loopfileHome(env as NodeJS.ProcessEnv);
    if (isLoopId(args.runId) || (await pathExists(loopPaths(home, args.runId).root))) {
      return await runLoopTail(args.runId, args.json, out, err, env, options);
    }
    const sinks = args.json
      ? { activity: discard, events: out }
      : { activity: out, events: discard };
    return await runTail(args.runId, sinks, err, env, options);
  } catch (error) {
    // Anything past this point is a filesystem or socket surprise `tail` has
    // no specific answer for, not one of the outcomes #51 names. It still
    // gets one `error:` line, never a stack trace on someone's terminal.
    return fail(err, error instanceof Error ? error.message : String(error));
  }
}

interface LoopTailRun {
  readonly index: number;
  readonly runId: string;
}

interface LoopTailContext {
  readonly loopId: string;
  readonly home: string;
  readonly paths: LoopPaths;
  readonly json: boolean;
  readonly out: Out;
  readonly err: Err;
  readonly env: Record<string, string | undefined>;
  readonly options: TailOptions;
}

/** Follows a loop log, handing each child run to the ordinary run follower. */
async function runLoopTail(
  loopId: string,
  json: boolean,
  out: Out,
  err: Err,
  env: Record<string, string | undefined>,
  options: TailOptions,
): Promise<number> {
  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const paths = loopPaths(home, loopId);
  if (!(await pathExists(paths.root))) {
    return loopFail(err, {
      summary: `no loop ${loopId}`,
      code: "no_such_loop",
      help: "Use `loopfile list` to find a valid loop ID.",
    });
  }

  const initial = await readOrMissing(paths.events);
  if (initial === undefined) {
    return loopFail(err, {
      summary: `events.jsonl for loop ${loopId} could not be opened`,
      code: "log_unreadable",
      help: "Check that events.jsonl exists and is readable.",
    });
  }

  const context = { loopId, home, paths, json, out, err, env, options } satisfies LoopTailContext;
  const first = splitCompleteLines(initial.text);
  const reader = { position: initial.size, remainder: first.remainder };
  const ended = await consumeLoopLines(first.lines, context);
  if (ended !== undefined) return ended;

  const sleep = options.sleep ?? realSleep;
  for (;;) {
    const read = await readNew(paths.events, reader.position);
    reader.position = read.pos;
    const split = splitCompleteLines(reader.remainder + read.text);
    reader.remainder = split.remainder;
    const result = await consumeLoopLines(split.lines, context);
    if (result !== undefined) return result;

    if ((await pingOwner(paths.socket, options.ownerPingTimeoutMs)) !== loopId) {
      const last = await readNew(paths.events, reader.position);
      reader.position = last.pos;
      const final = splitCompleteLines(reader.remainder + last.text);
      const finalResult = await consumeLoopLines(final.lines, context);
      if (finalResult !== undefined) return finalResult;
      return loopFail(err, {
        summary: `the loop owner for ${loopId} is gone`,
        code: "owner_gone",
        help: `Resume the crashed loop with: loopfile resume ${loopId}`,
      });
    }
    await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

async function consumeLoopLines(
  lines: readonly string[],
  context: LoopTailContext,
): Promise<number | undefined> {
  for (const line of lines) {
    const event = loopEventInLine(line);
    if (context.json) context.out(`${line}\n`);
    if (event === undefined) continue;
    const result = await consumeLoopEvent(event, context);
    if (result !== undefined) return result;
  }
  return undefined;
}

async function consumeLoopEvent(
  event: Record<string, unknown>,
  context: LoopTailContext,
): Promise<number | undefined> {
  switch (event.type) {
    case "loop.run_started":
      await consumeRunStarted(event, context);
      return undefined;
    case "loop.paused":
      if (!context.json) context.out(`loop: pause until ${stringOf(event.until)}\n`);
      return undefined;
    case "loop.ended": {
      const state = loopState(event.reason);
      if (!context.json) context.out(`loop: ended ${state} ${stringOf(event.reason)}\n`);
      return state === "completed" ? 0 : 1;
    }
    default:
      return undefined;
  }
}

async function consumeRunStarted(
  event: Record<string, unknown>,
  context: LoopTailContext,
): Promise<void> {
  const run = {
    index: numberOf(event.index),
    runId: stringOf(event.runId),
  } satisfies LoopTailRun;
  if (!context.json) context.out(`loop: run ${run.index} ${run.runId} started\n`);
  const ready = await waitForChildActivity(
    context.home,
    context.loopId,
    run.runId,
    context.paths,
    context.options,
  );
  const childCode = ready
    ? await tailCommand(
        ["tail", run.runId, ...(context.json ? ["--json"] : [])],
        context.out,
        context.err,
        context.env,
        context.options,
      )
    : 2;
  if (!context.json)
    context.out(
      `loop: run ${run.index} ${run.runId} ${await childState(
        context.home,
        run.runId,
        childCode,
      )}\n`,
    );
}

async function waitForChildActivity(
  home: string,
  loopId: string,
  runId: string,
  loop: LoopPaths,
  options: TailOptions,
): Promise<boolean> {
  const sleep = options.sleep ?? realSleep;
  for (;;) {
    if (await pathExists(runPaths(home, runId).activity)) return true;
    if (await loopHasEnded(loop.events)) return false;
    if ((await pingOwner(loop.socket, options.ownerPingTimeoutMs)) !== loopId) return false;
    await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}

async function loopHasEnded(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").some((line) => loopEventInLine(line)?.type === "loop.ended");
}

async function childState(home: string, runId: string, exitCode: number): Promise<string> {
  const text = await readFile(runPaths(home, runId).events, "utf8").catch(() => "");
  for (const line of text.split("\n").reverse()) {
    const event = jsonObject(line);
    if (event?.type === "run.cancelled") return "cancelled";
    if (event?.type === "run.ended") {
      return event.result === "success" ? "completed" : "failed";
    }
  }
  return exitCode === 0 ? "completed" : exitCode === 1 ? "failed" : "crashed";
}

function loopEventInLine(line: string): Record<string, unknown> | undefined {
  const event = jsonObject(line);
  return LOOP_EVENT_TYPES.has(String(event?.type)) ? event : undefined;
}

function jsonObject(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function loopState(reason: unknown): "completed" | "cancelled" | "failed" {
  if (reason === "source_empty" || reason === "max_runs") return "completed";
  if (reason === "cancelled") return "cancelled";
  return "failed";
}

function loopFail(err: Err, failure: OperatorFailure): 2 {
  err(renderOperatorFailure(failure).stderr);
  return 2;
}

async function runTail(
  runId: string,
  out: Sinks,
  err: Err,
  env: Record<string, string | undefined>,
  options: TailOptions,
): Promise<number> {
  const home = loopfileHome(env as NodeJS.ProcessEnv);
  const paths = runPaths(home, runId);

  if (!(await pathExists(paths.root))) return fail(err, unknownRunMessage(runId));

  const activity = await readOrMissing(paths.activity);
  if (activity === undefined) return fail(err, missingActivityLogMessage(runId));

  // Only whole lines are ever printed (#51): a trailing line with no newline
  // yet is held back as the first remainder `follow` reads against, the same
  // way a line split across two polls is, rather than printed as if it were
  // finished.
  const initialActivity = splitCompleteLines(activity.text);
  for (const line of initialActivity.lines.slice(-TAIL_LINE_COUNT)) out.activity(`${line}\n`);

  // `events.jsonl` is split the same way, and for the same reason `follow`
  // holds a remainder back: the first read can land mid-append, and a
  // half-written end event line that is dropped here is one no later poll can
  // ever complete, leaving `tail` to follow a finished run until its owner
  // goes and then call it gone (exit 2) instead of reading its end.
  const events = (await readOrMissing(paths.events)) ?? { text: "", size: 0 };
  const initialEvents = splitCompleteLines(events.text);
  const alreadyEnded = printThroughEnd(runId, initialEvents.lines, out.events);
  if (alreadyEnded !== undefined) {
    await flushActivity(paths, out.activity, activity.size, initialActivity.remainder);
    return await reportEnd(alreadyEnded, paths.ownerLog, err);
  }

  return await follow(
    paths,
    runId,
    out,
    err,
    activity.size,
    initialActivity.remainder,
    events.size,
    initialEvents.remainder,
    options,
  );
}

/**
 * Reads any activity written past `pos` and prints its whole lines, so a line
 * written just before an end event or a dead owner is caught is never lost.
 * Called once more right before every exit, on top of whatever a `follow`
 * poll already read that cycle: the run owner can write a final line and then
 * either its end event or its own exit in the gap between two reads that are
 * otherwise a few lines of code apart, and that gap is exactly what this
 * closes.
 */
async function flushActivity(
  paths: RunPaths,
  out: Out,
  pos: number,
  remainder: string,
): Promise<void> {
  const read = await readNew(paths.activity, pos);
  const split = splitCompleteLines(remainder + read.text);
  for (const line of split.lines) out(`${line}\n`);
}

/**
 * Polls `activity.log` and `events.jsonl` for new bytes and pings the run
 * owner, until an end event is seen (exit 0 or 1, by how the run ended) or
 * the run owner is gone with no end event (exit 2).
 *
 * `events.jsonl` is read the same buffered way as `activity.log`: a line the
 * run owner's `appendFile` split across two polls — or across `tail`'s first
 * read and its first poll — is held back as a remainder rather than checked
 * half-written, which would fail to parse and silently miss the end event
 * (`endInLine` swallows a parse failure).
 *
 * A ping that does not answer is checked once more against `events.jsonl`
 * before it is trusted: the run owner writes its end event and only then
 * closes the control socket (ADR 0008), so a poll that lands in that gap
 * would otherwise report a run that just finished cleanly as "gone". The
 * event found that way is the one reported, so a run whose last breath was a
 * failure still exits 1 rather than 0.
 *
 * Every exit reads `activity.log` one last time first (`flushActivity`), so a
 * line written just before the end event, or just before the owner died,
 * still gets printed rather than lost in the gap between that cycle's own
 * activity read and the check that decided to stop.
 */
async function follow(
  paths: RunPaths,
  runId: string,
  out: Sinks,
  err: Err,
  activityPos: number,
  activityRemainderInit: string,
  eventsPos: number,
  eventsRemainderInit: string,
  options: TailOptions,
): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? realSleep;
  let activityRemainder = activityRemainderInit;
  let eventsRemainder = eventsRemainderInit;

  for (;;) {
    const activityRead = await readNew(paths.activity, activityPos);
    activityPos = activityRead.pos;
    const activitySplit = splitCompleteLines(activityRemainder + activityRead.text);
    activityRemainder = activitySplit.remainder;
    for (const line of activitySplit.lines) out.activity(`${line}\n`);

    const eventsRead = await readNew(paths.events, eventsPos);
    eventsPos = eventsRead.pos;
    const eventsSplit = splitCompleteLines(eventsRemainder + eventsRead.text);
    eventsRemainder = eventsSplit.remainder;
    const ended = printThroughEnd(runId, eventsSplit.lines, out.events);
    if (ended !== undefined) {
      await flushActivity(paths, out.activity, activityPos, activityRemainder);
      return await reportEnd(ended, paths.ownerLog, err);
    }

    const answer = await pingOwner(paths.socket, options.ownerPingTimeoutMs);
    if (answer !== runId) {
      const lastEventsRead = await readNew(paths.events, eventsPos);
      const endedAfterAll = printLastEvents(
        runId,
        eventsRemainder + lastEventsRead.text,
        out.events,
      );
      await flushActivity(paths, out.activity, activityPos, activityRemainder);
      return endedAfterAll === undefined
        ? fail(err, ownerGoneMessage(runId))
        : await reportEnd(endedAfterAll, paths.ownerLog, err);
    }

    await sleep(pollIntervalMs);
  }
}

/** Prints `lines` through the first end event, and gives that end. */
function printThroughEnd(runId: string, lines: readonly string[], out: Out): RunEnd | undefined {
  const through = throughEnd(runId, lines);
  for (const line of through.lines) out(`${line}\n`);
  return through.end;
}

/**
 * Prints the events read after the owner was found gone, and gives the end
 * among them. A line with no newline never gets one now, so it is printed
 * only when it is the end event itself, which parsed whole.
 */
function printLastEvents(runId: string, text: string, out: Out): RunEnd | undefined {
  const last = splitCompleteLines(text);
  const withRemainder = throughEnd(runId, [...last.lines, last.remainder]);
  const printed = withRemainder.end === undefined ? last.lines : withRemainder.lines;
  for (const line of printed) out(`${line}\n`);
  return withRemainder.end;
}

/**
 * The bytes of `path` past byte offset `from`, and the offset to read from
 * next. Missing is empty: a follow loop is never surprised by a file that has
 * not been created yet.
 *
 * Reads only the new bytes at a positional offset rather than the whole file:
 * `activity.log` and `events.jsonl` both grow for as long as `tail` follows
 * them, and re-reading everything on every poll would cost more with every
 * cycle for no more payload than the last few lines.
 *
 * The offset is a byte count, not a character count, because both files can
 * carry multi-byte UTF-8 text and only a byte offset lines up with what
 * `fs.stat`'s `size` reports.
 */
async function readNew(path: string, from: number): Promise<{ text: string; pos: number }> {
  const handle = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (handle === undefined) return { text: "", pos: from };

  try {
    const size = (await handle.stat()).size;
    if (size <= from) return { text: "", pos: from };
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    return { text: buffer.toString("utf8"), pos: size };
  } finally {
    await handle.close();
  }
}

/** `path`'s content and byte size, or nothing when it does not exist. */
async function readOrMissing(path: string): Promise<{ text: string; size: number } | undefined> {
  return await readFile(path)
    .then((buffer) => ({ text: buffer.toString("utf8"), size: buffer.byteLength }))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writes the end text for a run that did not complete and gives its exit
 * code. A completed run gets nothing: `tail` already printed its log, and a
 * script reads the 0.
 */
async function reportEnd(end: RunEnd, ownerLog: string, err: Err): Promise<number> {
  if (end.endReason === "internal_error") {
    const summary = endedHelp(end).split("\n", 1)[0] ?? "run failed: internal_error";
    err(
      renderOperatorFailure(
        { summary, code: "operation_failed", help: await ownerLogHelp(ownerLog) },
        1,
      ).stderr,
    );
  } else {
    err(endedHelp(end));
  }
  return endedExitCode(end);
}

/** Every `tail` problem that is not the run's own end: a Loopfile problem, exit 2 (#185). */
function fail(err: Err, message: string): 2 {
  err(`error: ${message}\n`);
  return 2;
}
