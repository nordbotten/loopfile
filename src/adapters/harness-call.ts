/**
 * Runs one harness call through the executor (#23, ADR 0004).
 *
 * The adapter only describes the call and reads its stdout lines. This file
 * writes its wiring files, starts the process, keeps the raw output and feeds
 * activity to the caller. It has no timer: the caller holds `cancel`.
 */

import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import type { Ended, Executor, RunningProcess, StartFailure } from "../application/executor.ts";
import type {
  HarnessActivity,
  HarnessAdapter,
  HarnessCall,
  PreparedHarnessCall,
} from "../application/harness.ts";
import type { IterationPaths } from "./attempt-directory.ts";

export type HarnessCallStart =
  | (StartFailure & { readonly reason: "start_failed" })
  | (Pick<RunningProcess, "kind" | "processGroupId" | "cancel"> & {
      /** Settles after the process ended, both files are written and every line is parsed. */
      readonly ended: Promise<Ended>;
    });

export async function startHarnessCall(
  executor: Executor,
  adapter: HarnessAdapter,
  call: HarnessCall,
  output: Pick<IterationPaths, "stdout" | "stderr">,
  onActivity: (activity: HarnessActivity) => void,
): Promise<HarnessCallStart> {
  const prepared = adapter.prepare(call);
  const names = Object.keys(prepared.wiringFiles);
  for (const name of names) {
    if (name.includes("/") || name === "." || name === "..") {
      throw new Error(`wiring file name is not a plain file name: ${name}`);
    }
  }
  for (const name of names) {
    await writeFile(join(call.wiringFolder, name), prepared.wiringFiles[name] as string);
  }

  const started = await executor.start({
    command: prepared.command,
    args: prepared.args,
    stdin: prepared.stdin,
    context: call.context,
  });
  if (started.kind === "start-failed") return { ...started, reason: "start_failed" };

  const ended = Promise.all([
    started.ended,
    pipeline(started.stdout, lineTap(prepared, onActivity), createWriteStream(output.stdout)),
    pipeline(started.stderr, createWriteStream(output.stderr)),
  ]).then(([end]) => end);

  return {
    kind: "running",
    processGroupId: started.processGroupId,
    cancel: () => started.cancel(),
    ended,
  };
}

/** Passes every chunk on unchanged, and gives each complete UTF-8 line to the adapter. */
function lineTap(
  prepared: PreparedHarnessCall,
  onActivity: (activity: HarnessActivity) => void,
): (source: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const parse = (line: string): void => {
    let found: readonly HarnessActivity[];
    try {
      found = prepared.parseStdoutLine(line);
    } catch {
      return; // Lost activity never fails a call.
    }
    for (const activity of found) onActivity(activity);
  };
  const feed = (text: string): void => {
    pending += text;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  };
  return async function* tap(source) {
    for await (const chunk of source) {
      feed(decoder.write(Buffer.from(chunk)));
      yield chunk;
    }
    feed(decoder.end());
    if (pending !== "") parse(pending);
  };
}
