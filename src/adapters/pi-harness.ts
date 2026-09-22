/**
 * The PI harness adapter (#141, ADR 0004, ADR 0005).
 *
 * It describes one `pi -p --mode json` call and reads its JSON event lines.
 * The prompt goes on stdin (tested with `pi` 0.85.1). It sets no provider, key
 * or auth variable: the user's own `pi` login applies. `pi` has no sandbox, so
 * there are no wiring files. The adapter never reads `stopReason` to find an
 * outcome (ADR 0004): only `loopfile result` reports one. It reads it only to
 * show an error message as progress.
 *
 * `pi` can retry, so a call can end more than once. Each `metrics` activity is
 * the call's total so far, never a delta.
 */

import { isAbsolute, relative, sep } from "node:path";
import type { HarnessActivity, HarnessAdapter } from "../application/harness.ts";
import type { StatusMetrics } from "../domain/status.ts";

type JsonObject = Readonly<Record<string, unknown>>;

interface Totals {
  input: number | null;
  output: number | null;
  cost: number | null;
}

export const piAdapter: HarnessAdapter = {
  prepare(call) {
    let toolCalls = 0;
    let totals: Totals = { input: 0, output: 0, cost: 0 };
    return {
      command: "pi",
      args: [
        ...call.args,
        "-p",
        "--mode",
        "json",
        "--no-session",
        ...(call.model === undefined ? [] : ["--model", call.model]),
        ...(call.effort === undefined ? [] : ["--thinking", call.effort]),
      ],
      stdin: call.prompt,
      wiringFiles: {},
      parseStdoutLine(line) {
        const event = parseObject(line);
        switch (event?.type) {
          case "tool_execution_start":
            toolCalls++;
            return [toolActivity(event, call.context.workspace)];
          case "message_end": {
            const message = asObject(event.message);
            if (message?.role !== "assistant") return [];
            totals = add(totals, asObject(message.usage));
            return messageActivities(message);
          }
          case "agent_end":
            return [{ kind: "metrics", metrics: metrics(totals, toolCalls) }];
          default:
            return [];
        }
      },
    };
  },
};

function toolActivity(event: JsonObject, workspace: string): HarnessActivity {
  const tool = text(event.toolName);
  return { kind: "tool", tool, target: target(tool, asObject(event.args), workspace) };
}

/** Each `text` block is progress, and so is the message of an error stop. */
function messageActivities(message: JsonObject): HarnessActivity[] {
  const found: HarnessActivity[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content.map(asObject)) {
      if (block?.type === "text") found.push({ kind: "progress", text: text(block.text) });
    }
  }
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  const error = text(message.errorMessage);
  if (failed && error !== "") found.push({ kind: "progress", text: error });
  return found;
}

const TARGET_FIELDS = new Map([
  ["bash", "command"],
  ["read", "path"],
  ["edit", "path"],
  ["write", "path"],
  ["ls", "path"],
  ["grep", "pattern"],
  ["find", "pattern"],
]);

const PATH_FIELDS = new Set(["path"]);

function target(tool: string, args: JsonObject | undefined, workspace: string): string {
  const field = TARGET_FIELDS.get(tool);
  const value = field === undefined ? "" : text(args?.[field]);
  return PATH_FIELDS.has(field ?? "") ? workspaceRelative(value, workspace) : value;
}

/** A path inside the workspace, relative to it. Any other path as it was given. */
function workspaceRelative(path: string, workspace: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(workspace, path);
  const outside = inside === "" || inside === ".." || inside.startsWith(`..${sep}`);
  return outside ? path : inside;
}

/** A missing or non-number field makes that total unknown for the rest of the call. */
function add(totals: Totals, usage: JsonObject | undefined): Totals {
  const input = plus(plus(count(usage?.input), count(usage?.cacheRead)), count(usage?.cacheWrite));
  return {
    input: plus(totals.input, input),
    output: plus(totals.output, count(usage?.output)),
    cost: plus(totals.cost, count(asObject(usage?.cost)?.total)),
  };
}

function metrics(totals: Totals, toolCalls: number): StatusMetrics {
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    totalTokens: plus(totals.input, totals.output),
    costUsd: totals.cost,
    toolCalls,
  };
}

function parseObject(line: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Unknown plus anything is unknown. */
function plus(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}
