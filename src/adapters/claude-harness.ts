/**
 * The Claude Code harness adapter (#24, ADR 0004, ADR 0005, ADR 0007).
 *
 * It describes one `claude -p` call and reads its `stream-json` stdout. It
 * runs on the user's subscription login: it never passes `--bare` (which
 * reads only an API key) and sets no auth variable.
 *
 * The prompt goes on stdin, never on the command line (#132 D5). The step's
 * `args` come first, so the adapter's `--settings` is the last one: `claude`
 * keeps only the last `--settings` flag (tested with claude 2.1.276), so the
 * adapter takes a user's `--settings '<json>'` out of `args` and merges it
 * into its own `settings.json`. Objects merge, lists join and the user's
 * other values win. The value must be inline JSON: a path is an error.
 *
 * `settings.json` lets the agent reach the run owner. It never sets
 * `sandbox.enabled`, so the user's own sandbox choice stays, and Claude Code
 * merges these lists with the user's settings. `allowUnixSockets` works only
 * on macOS: on Linux the sandbox blocks Unix sockets with seccomp, so
 * `excludedCommands` runs `loopfile` outside the sandbox. `acceptEdits` lets
 * the agent edit files; other Bash commands stay denied unless the user
 * widens them with `--permission-mode` in `args`, which wins over this file.
 *
 * The adapter never reads `result`, `subtype` or `is_error` to find an
 * outcome (ADR 0004): only `loopfile result` reports one.
 */

import { isAbsolute, join, relative, sep } from "node:path";
import type { HarnessActivity, HarnessAdapter, HarnessCall } from "../application/harness.ts";
import type { StatusMetrics } from "../domain/status.ts";

type JsonObject = Readonly<Record<string, unknown>>;

export const claudeAdapter: HarnessAdapter = {
  prepare(call) {
    let toolCalls = 0;
    const { args, userSettings } = takeSettings(call.args);
    return {
      command: "claude",
      args: [
        ...args,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--settings",
        join(call.wiringFolder, "settings.json"),
        ...(call.model === undefined ? [] : ["--model", call.model]),
        ...(call.effort === undefined ? [] : ["--effort", call.effort]),
      ],
      stdin: call.prompt,
      wiringFiles: { "settings.json": JSON.stringify(merge(settings(call), userSettings)) },
      parseStdoutLine(line) {
        const event = parseObject(line);
        if (event?.type === "assistant") {
          const found = assistantActivities(event, call.context.workspace);
          toolCalls += found.filter((activity) => activity.kind === "tool").length;
          return found;
        }
        if (event?.type !== "result") return [];
        return [{ kind: "metrics", metrics: metrics(event, toolCalls) }];
      },
    };
  },
};

/** Splits the `--settings` flags, in the `--flag value` and `--flag=value` forms, out of `args`. */
function takeSettings(all: readonly string[]): {
  args: string[];
  userSettings: JsonObject;
} {
  const args: string[] = [];
  let userSettings: JsonObject = {};
  for (let i = 0; i < all.length; i++) {
    const arg = all[i] as string;
    if (arg !== "--settings" && !arg.startsWith("--settings=")) {
      args.push(arg);
      continue;
    }
    const value = arg === "--settings" ? all[++i] : arg.slice("--settings=".length);
    userSettings = merge(userSettings, parseSettings(value));
  }
  return { args, userSettings };
}

function parseSettings(value: string | undefined): JsonObject {
  const parsed = value === undefined ? undefined : parseObject(value);
  if (parsed === undefined) {
    throw new Error("--settings in args must be followed by inline JSON that is a map");
  }
  return parsed;
}

/** Maps merge deeply, lists join without repeats, and `over` wins any other clash. */
function merge(base: JsonObject, over: JsonObject): JsonObject {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const before = merged[key];
    const a = asObject(before);
    const b = asObject(value);
    if (a !== undefined && b !== undefined) merged[key] = merge(a, b);
    else if (Array.isArray(before) && Array.isArray(value)) {
      merged[key] = [...before, ...value.filter((item) => !before.includes(item))];
    } else merged[key] = value;
  }
  return merged;
}

function settings({ context }: HarnessCall) {
  return {
    permissions: {
      allow: ["Bash(loopfile data *)", "Bash(loopfile result *)"],
      additionalDirectories: [context.scratch],
      defaultMode: "acceptEdits",
    },
    sandbox: {
      excludedCommands: ["loopfile *"],
      network: { allowUnixSockets: [context.endpoint] },
      filesystem: { allowWrite: [context.scratch] },
    },
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

/** Each `tool_use` block is a tool call and each `text` block is progress. Thinking is neither. */
function assistantActivities(event: JsonObject, workspace: string): HarnessActivity[] {
  const content = asObject(event.message)?.content;
  if (!Array.isArray(content)) return [];
  const found: HarnessActivity[] = [];
  for (const block of content.map(asObject)) {
    if (block?.type === "tool_use") {
      const tool = text(block.name);
      found.push({ kind: "tool", tool, target: target(tool, block.input, workspace) });
    } else if (block?.type === "text") {
      found.push({ kind: "progress", text: text(block.text) });
    }
  }
  return found;
}

/** The input field that names what a tool acts on. `NotebookEdit` calls its path `notebook_path`. */
const TARGET_FIELDS = new Map([
  ["Bash", "command"],
  ["Read", "file_path"],
  ["Edit", "file_path"],
  ["Write", "file_path"],
  ["NotebookEdit", "notebook_path"],
  ["Glob", "pattern"],
  ["Grep", "pattern"],
  ["WebFetch", "url"],
  ["WebSearch", "query"],
  ["Task", "description"],
  ["Agent", "description"],
]);

const PATH_FIELDS = new Set(["file_path", "notebook_path"]);

function target(tool: string, input: unknown, workspace: string): string {
  const field = TARGET_FIELDS.get(tool);
  const value = field === undefined ? "" : text(asObject(input)?.[field]);
  return PATH_FIELDS.has(field ?? "") ? workspaceRelative(value, workspace) : value;
}

/** A path inside the workspace, relative to it. Any other path as it was given. */
function workspaceRelative(path: string, workspace: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(workspace, path);
  const outside = inside === "" || inside === ".." || inside.startsWith(`..${sep}`);
  return outside ? path : inside;
}

/** Input counts cached input too: `input_tokens` alone was 17 of about 41,600 in a real run. */
function metrics(event: JsonObject, toolCalls: number): StatusMetrics {
  const usage = asObject(event.usage);
  const inputTokens = plus(
    plus(count(usage?.input_tokens), count(usage?.cache_creation_input_tokens)),
    count(usage?.cache_read_input_tokens),
  );
  const outputTokens = count(usage?.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: plus(inputTokens, outputTokens),
    costUsd: count(event.total_cost_usd),
    toolCalls,
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Unknown plus anything is unknown. */
function plus(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}
