/**
 * The run owner process and its two sockets (#115).
 *
 * One run owner carries out a run and is the only writer of its event log (ADR
 * 0003). It binds two kinds of socket:
 *
 * - The **control socket**, `runs/<runid>/owner.sock` (ADR 0008). It answers a
 *   ping with the run ID, greets every client with "ready" once the owner can
 *   take work, and is the run's lock: a second run owner refuses to start
 *   while the first one answers.
 * - An **attempt socket** in each attempt folder, the value behind
 *   `LOOPFILE_ENDPOINT` (ADR 0005). It answers only the attempt — and on a
 *   Ralph step only the iteration — that is running now, and hands the call to
 *   a handler. The handlers are #19, #20 and #26.
 *
 * What the two sides say is `owner-protocol.ts`; this file is binding,
 * connecting and unlinking, and nothing else decides anything here.
 *
 * The control socket also takes `cancel` (#63) and `interrupt` (#53). The run
 * owner answers them; stopping the run or attempt is `workflow-run.ts`'s
 * (#116). Spawning the process is #35.
 */

import { unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import {
  type AttemptCall,
  type AttemptIdentity,
  answeredRunId,
  CANCEL,
  checkAttemptCall,
  confirmsCancel,
  confirmsInterrupt,
  controlReply,
  encodeMessage,
  INTERRUPT,
  PING,
  readyMessage,
  refusesInterrupt,
} from "../application/owner-protocol.ts";
import { withActivityHook } from "./activity-log.ts";
import { type EventLog, type NewEvent, openEventLog } from "./event-log.ts";
import { checkSocketPathLength, type RunPaths, runPaths } from "./run-directory.ts";

/** Thrown when a run owner cannot start. The message always names the path. */
export class RunOwnerError extends Error {}

/** Thrown when another run owner already answers on this run's control socket. */
export class RunOwnerBusyError extends RunOwnerError {}

/** How long a stale-socket probe waits for an answer before calling the socket dead. */
export const PROBE_TIMEOUT_MS = 2_000;

/** What a step command's call gets back. Its shape belongs to #19, #20 and #26. */
export type AttemptCallHandler = (call: AttemptCall) => Promise<unknown> | unknown;

/** One attempt's socket, served while the attempt runs. */
export interface AttemptEndpoint {
  /** The value to put in `LOOPFILE_ENDPOINT` (ADR 0005). */
  readonly endpoint: string;
  /** Aborted when `loopfile interrupt` stops this attempt. */
  readonly interruptSignal: AbortSignal;
  /** Stops answering. Called when the attempt or the iteration ends. */
  close(): Promise<void>;
}

/** A started run owner. */
export interface RunOwner {
  readonly runId: string;
  readonly paths: RunPaths;
  /** The run's one append path. Nothing else writes `events.jsonl`. */
  readonly events: EventLog;
  /** Serves one attempt's socket until it is closed. */
  serveAttempt(options: ServeAttemptOptions): Promise<AttemptEndpoint>;
  /** Settles when the control socket stops listening. */
  readonly stopped: Promise<void>;
  /**
   * Aborted by `cancel` on the control socket, or by `cancelSignal` (#63).
   * Whoever runs the steps stops the run when it fires.
   */
  readonly cancelled: AbortSignal;
  /** Closes both sockets and the event log, and removes the control socket file. */
  close(): Promise<void>;
}

/** What one attempt's socket needs to answer calls. */
export interface ServeAttemptOptions {
  /** The attempt folder's `sock` (`attemptPaths().socket`). */
  readonly socketPath: string;
  /**
   * The attempt, and on a Ralph step the iteration, that is running now. Read
   * for each call. `undefined` means none is running, and every call is refused.
   */
  current(): AttemptIdentity | undefined;
  readonly handle: AttemptCallHandler;
}

/** What a run owner starts from. */
export interface StartRunOwnerOptions {
  /** The Loopfile home, usually from `loopfileHome()`. */
  readonly home: string;
  readonly runId: string;
  /** Overridable for tests only. */
  readonly probeTimeoutMs?: number;
  /**
   * Makes a new run's `run.created`, which must be the first event of the log
   * (ADR 0003), so it is appended before `owner.started`. Called after the
   * socket is bound and the log is open, so a second run owner never gets here.
   * Left out when the log already has its `run.created`, as on a resume.
   */
  readonly created?: () => Promise<NewEvent>;
  /** A cancel from outside the control socket: a signal to the run owner (#63). */
  readonly cancelSignal?: AbortSignal;
  /** Overridable for tests only. */
  readonly eventLog?: EventLog;
}

/**
 * Starts the run owner for `runId`: takes the control socket, records itself in
 * the event log and starts answering.
 *
 * The socket is the lock (ADR 0008). A socket file that answers means a live
 * run owner and this one refuses to start. A socket file that does not answer
 * is what a crash leaves behind, so it is removed and the bind is tried once
 * more — once, because a second failure is not a leftover.
 */
export async function startRunOwner(options: StartRunOwnerOptions): Promise<RunOwner> {
  const paths = runPaths(options.home, options.runId);
  checkSocketPathLength(paths.socket);

  // Greeting is held back until the event log is open, because "ready" means
  // the run owner can take work (ADR 0008) and a run owner that cannot write
  // its log takes none. The socket answers a ping from the moment it is bound,
  // because that is what makes it the lock.
  let greet: ((socket: Socket) => void) | undefined;
  const waiting = new Set<Socket>();
  const cancel = linkedController(options.cancelSignal);
  let currentInterrupt: AbortController | undefined;
  const control = lineServer((socket) => {
    if (greet) greet(socket);
    else waiting.add(socket);
    onLine(socket, (line) =>
      handleControlLine(socket, line, options.runId, cancel, () => currentInterrupt),
    );
  });
  // A bind that fails leaves the server object holding the handle its failed
  // attempt opened, which keeps the process alive after the error is passed on.
  await bindExclusive(control, paths.socket, options.runId, options.probeTimeoutMs).catch(
    async (error: unknown) => {
      await control.close();
      throw error;
    },
  );

  const events = await openOwnerEventLog(paths, control, options.eventLog);
  await appendCreated(options.created, events, paths, control);
  await events.append({ type: "owner.started", pid: process.pid, host: hostname() });

  greet = (socket: Socket) => socket.write(encodeMessage(readyMessage(options.runId)));
  for (const socket of waiting) greet(socket);
  waiting.clear();

  const attempts = new Set<LineServer>();
  const stopped = new Promise<void>((resolve) => control.server.once("close", () => resolve()));

  return {
    runId: options.runId,
    paths,
    events,
    stopped,
    cancelled: cancel.signal,
    async serveAttempt(serve: ServeAttemptOptions): Promise<AttemptEndpoint> {
      const served = await serveAttemptSocket(serve);
      const interrupt = new AbortController();
      currentInterrupt = interrupt;
      attempts.add(served);
      return {
        endpoint: serve.socketPath,
        interruptSignal: interrupt.signal,
        close: async () => {
          if (currentInterrupt === interrupt) currentInterrupt = undefined;
          attempts.delete(served);
          await served.close();
        },
      };
    },
    async close(): Promise<void> {
      for (const attempt of [...attempts]) await attempt.close();
      attempts.clear();
      await control.close();
      await events.close();
      await unlink(paths.socket).catch(() => undefined);
    },
  };
}

/** A controller that also aborts when `outside` does. */
function handleControlLine(
  socket: Socket,
  line: string,
  runId: string,
  cancel: AbortController,
  currentInterrupt: () => AbortController | undefined,
): void {
  const active = currentInterrupt();
  const reply = controlReply(line, runId, active !== undefined && !active.signal.aborted);
  if (reply.type === "cancelling") cancel.abort();
  if (reply.type === "interrupting") active?.abort();
  socket.write(encodeMessage(reply));
}

function linkedController(outside: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (outside?.aborted) controller.abort();
  outside?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/**
 * Appends the new run's `run.created` when there is one to make, or gives the
 * control socket back and passes the failure on.
 *
 * As for a log that will not open: nothing else may take this run while a
 * half-started owner holds its socket.
 */
async function appendCreated(
  created: (() => Promise<NewEvent>) | undefined,
  events: EventLog,
  paths: RunPaths,
  control: LineServer,
): Promise<void> {
  if (created === undefined) return;
  await Promise.resolve()
    .then(created)
    .then((event) => events.append(event))
    .catch(async (error: unknown) => {
      await events.close().catch(() => undefined);
      await control.close();
      await unlink(paths.socket).catch(() => undefined);
      throw error;
    });
}

/**
 * Opens the run's event log, wrapped so every appended event also gets its
 * activity.log lifecycle line (ADR 0007), or gives the control socket back
 * and passes the failure on.
 *
 * Split out of `startRunOwner` so that function's own branching stays
 * readable: this is the one place opening the log can fail, and the one
 * place that failure's cleanup lives.
 */
async function openOwnerEventLog(
  paths: RunPaths,
  control: LineServer,
  existing?: EventLog,
): Promise<EventLog> {
  return await Promise.resolve(existing ?? openEventLog(paths.events))
    .then((log) => (existing === undefined ? withActivityHook(log, paths.activity) : log))
    .catch(async (error: unknown) => {
      // Nothing else may take this run while a half-started owner holds its
      // socket, so the lock goes back before the failure is passed on.
      await control.close();
      await unlink(paths.socket).catch(() => undefined);
      throw error;
    });
}

/**
 * Serves one attempt's socket.
 *
 * A call is answered only when it matches the attempt that is running now, so
 * a process left over from an ended attempt or iteration gets a refusal rather
 * than a write into somebody else's attempt (ADR 0005).
 */
async function serveAttemptSocket(options: ServeAttemptOptions): Promise<LineServer> {
  checkSocketPathLength(options.socketPath);
  const served = lineServer((socket) => {
    onLine(socket, (line) => {
      const check = checkAttemptCall(line, options.current());
      if (!check.accepted) {
        socket.write(encodeMessage(check.refusal));
        return;
      }
      // A handler that throws is the run owner's problem to answer, not to die
      // of: it is the only writer of the event log, and the step is waiting on
      // this line.
      void Promise.resolve(options.handle(check.call)).then(
        (reply) => socket.write(encodeMessage(reply)),
        (error: unknown) => {
          socket.write(encodeMessage({ ok: false, code: "failed", message: String(error) }));
        },
      );
    });
  });
  await listen(served.server, options.socketPath);
  return served;
}

/**
 * Binds the control socket, replacing a leftover from a crashed run owner.
 *
 * A file that answers belongs to a run owner that is still running, whatever
 * it answers with, so it is never removed: refusing to start is the whole
 * point of the lock.
 */
async function bindExclusive(
  served: LineServer,
  path: string,
  runId: string,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<void> {
  const inUse = await listen(served.server, path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") return true;
      throw bindError(error, path);
    },
  );
  if (!inUse) return;

  const answer = await pingOwner(path, probeTimeoutMs);
  if (answer === runId) {
    throw new RunOwnerBusyError(
      `another run owner is already running for this run: ${path}. ` +
        "Use `loopfile cancel` to stop it, or wait for it to finish.",
    );
  }
  if (answer !== undefined) {
    throw new RunOwnerBusyError(
      `something else is already listening on ${path}, and it answers for run ${answer}. ` +
        "Move it out of the way by hand: a socket another process is serving is never removed.",
    );
  }
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    throw bindError(error, path);
  });
  await listen(served.server, path).catch((error: NodeJS.ErrnoException) => {
    throw bindError(error, path);
  });
}

function bindError(error: NodeJS.ErrnoException, path: string): RunOwnerError {
  return new RunOwnerError(`cannot bind the control socket (${error.code}): ${path}`, {
    cause: error,
  });
}

/**
 * The run ID whatever is serving `path` answers with, or nothing when nothing
 * answers.
 *
 * Liveness is "the socket answers with the right run ID" (ADR 0008), so the
 * answer is read rather than counted: an unrelated program bound at the path
 * answers too, and removing its socket is not this process's to do. Exported
 * because `tail` (#51) asks the same question of a run it does not own, and a
 * second implementation of "ping and read the reply" would be one more place
 * for the two to drift apart.
 */
export async function pingOwner(
  path: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  return await askOwner(path, { type: PING }, answeredRunId, timeoutMs);
}

/**
 * Sends `cancel` to the run owner of `runId` and says whether it took it
 * (#63). `false` means nothing answered for that run in time.
 */
export async function requestCancel(
  path: string,
  runId: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const confirm = (line: string) => (confirmsCancel(line, runId) ? true : undefined);
  return (await askOwner(path, { type: CANCEL }, confirm, timeoutMs)) === true;
}

/**
 * Asks the live owner to interrupt its current attempt.
 *
 * `undefined` means no owner answered; `false` means the owner is alive but
 * there is no attempt to interrupt.
 */
export async function requestInterrupt(
  path: string,
  runId: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean | undefined> {
  const reply = (line: string): boolean | undefined => {
    if (confirmsInterrupt(line, runId)) return true;
    if (refusesInterrupt(line)) return false;
    return undefined;
  };
  return await askOwner(path, { type: INTERRUPT }, reply, timeoutMs);
}

/**
 * Sends one request on a control socket and gives the first line `read`
 * makes something of, or nothing when no such line comes in time. Every
 * other line, such as the "ready" greeting, is skipped.
 */
async function askOwner<T>(
  path: string,
  request: object,
  read: (line: string) => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve) => {
    const socket = connect(path);
    let pending = "";
    const done = (value: T | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => socket.write(encodeMessage(request)));
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const value = read(line);
        if (value !== undefined) return done(value);
      }
    });
    socket.on("error", () => done(undefined));
    socket.on("close", () => done(undefined));
  });
}

/** Calls `handler` once for each complete line the socket delivers. */
function onLine(socket: Socket, handler: (line: string) => void): void {
  let pending = "";
  socket.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") handler(line);
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** A socket server that also knows its open connections. */
interface LineServer {
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * A server that greets and answers over lines, and can be closed at once.
 *
 * The open connections are tracked because `close` otherwise waits for each
 * one to end on its own, and a step's process can be gone without having
 * closed its socket. `net.Server` has no `closeAllConnections` of its own.
 */
function lineServer(onConnection: (socket: Socket) => void): LineServer {
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => socket.destroy());
    onConnection(socket);
  });
  // A server-level error after a successful listen — a client that went away
  // mid-accept is the common one — has no listener of its own, and `error` with
  // no listener throws. The run owner outlives one broken connection.
  server.on("error", () => undefined);
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  };
}
