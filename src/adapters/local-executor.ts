/**
 * The local process executor: the v1 implementation of the executor interface
 * (#12, ADR 0004).
 *
 * A local process sees the context's logical values as they are, so nothing is
 * mapped. Each process leads its own process group, which is how cancel reaches
 * every child a step started without knowing about them.
 *
 * The caller must read both pipes to their end. A pipe nobody reads fills up
 * and stops the process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  CANCEL_GRACE_MS,
  CONTEXT_VARIABLE_NAMES,
  contextEnvironment,
  type Ended,
  type Executor,
  type StartRequest,
  type StartResult,
} from "../application/executor.ts";

/**
 * An executor that starts processes on this machine, with `launchEnv` under the
 * `LOOPFILE_*` variables. `cancelGraceMs` is there for tests; the run owner
 * keeps the default.
 */
export function localExecutor(
  launchEnv: NodeJS.ProcessEnv = process.env,
  cancelGraceMs = CANCEL_GRACE_MS,
): Executor {
  return {
    start: (request) => start(request, launchEnv, cancelGraceMs),
  };
}

async function start(
  { command, args, context, stdin }: StartRequest,
  launchEnv: NodeJS.ProcessEnv,
  cancelGraceMs: number,
): Promise<StartResult> {
  const contextEnv = contextEnvironment(context);
  const child = spawn(command, args, {
    cwd: context.workspace,
    env: {
      ...Object.fromEntries(
        Object.entries(launchEnv).filter(
          ([name]) => !(CONTEXT_VARIABLE_NAMES as readonly string[]).includes(name),
        ),
      ),
      ...contextEnv,
    },
    detached: true,
    stdio: [stdinMode(stdin), "pipe", "pipe"],
  });
  const ended = new Promise<Ended>((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(
        signal === null ? { kind: "exited", code: code ?? 0 } : { kind: "signalled", signal },
      ),
    );
  });
  const spawnError = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", resolve);
  });
  if (spawnError !== undefined) {
    return { kind: "start-failed", message: spawnError.message, code: spawnError.code };
  }

  writeStdin(child, stdin);

  // Detached, so the child's pid is also its process group ID.
  const processGroupId = child.pid as number;
  let cancelled = false;
  return {
    kind: "running",
    processGroupId,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    ended,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      signalGroup(processGroupId, "SIGTERM");
      // ponytail: a group that is gone by then answers ESRCH, which is "not
      // alive". A group ID the kernel reused inside the grace period would get
      // the SIGKILL; that needs pid_max IDs used up in ten seconds. Check the
      // group's start time before the kill if that ever becomes real.
      setTimeout(() => signalGroup(processGroupId, "SIGKILL"), cancelGraceMs);
    },
  };
}

/** A closed stdin unless there is text to write. */
function stdinMode(stdin: string | undefined): "ignore" | "pipe" {
  return stdin === undefined ? "ignore" : "pipe";
}

/** Writes `stdin` and closes the pipe. Nothing to write means stdin is already closed. */
function writeStdin(child: ChildProcess, stdin: string | undefined): void {
  if (stdin === undefined || child.stdin === null) return;
  // A process that never reads stdin may exit first; that is its choice, not an error.
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
}

/** True when the process group still has a process in it. */
export function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signals every process in the group. A group that is already gone is not an error. */
function signalGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
