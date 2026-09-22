import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { HarnessCall } from "../application/harness.ts";
import { claudeAdapter } from "./claude-harness.ts";

const attempt = "/runs/2026-09-18-0001/attempts/001-work";

/** The workspace of the recorded run below, so its Edit path is inside it. */
const context: ExecutionContext = {
  runId: "2026-09-18-0001",
  attemptId: "001-work",
  stepId: "work",
  workspace: "/tmp/loopfile-24-rec-bd57d19b/ws",
  scratch: `${attempt}/scratch`,
  endpoint: `${attempt}/sock`,
  attemptSecret: "s3cret",
};

const call: HarnessCall = {
  context,
  prompt: "Fix the failing test, then run `loopfile result done`.",
  args: [],
  wiringFolder: `${attempt}/wiring`,
};

/*
 * Lines from a real `claude -p --output-format stream-json --verbose` run
 * (claude 2.1.277, haiku). Only the thinking block's opaque signature is cut.
 */
const recorded = {
  system: `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"a5332046-7edd-4e2d-aa53-c763b5fa9c93"}`,
  thinking: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfBPhmL6MkaNLS7N1Erbd","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"EqYICrIBCBEYAipA74Vm1ppx32jV0zkJ"}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":14713,"cache_read_input_tokens":13701,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":14713},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"e1446eb0-bc84-4b74-8e71-b2c046f14c9e","timestamp":"2026-09-18T18:39:07.801Z","request_id":"req_011CfBPhktYbeBHj8XXRatju"}`,
  bash: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfBPhmL6MkaNLS7N1Erbd","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01K85tZdfoaAVvi7anTPrfP9","name":"Bash","input":{"command":"echo hi","description":"Echo hi"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":14713,"cache_read_input_tokens":13701,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":14713},"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"137d3456-409c-43d6-8320-bbcf49157562","timestamp":"2026-09-18T18:39:08.222Z","request_id":"req_011CfBPhktYbeBHj8XXRatju","wire_tool_inputs":{"toolu_01K85tZdfoaAVvi7anTPrfP9":{"command":"echo hi","description":"Echo hi"}}}`,
  user: `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01K85tZdfoaAVvi7anTPrfP9","type":"tool_result","content":"hi","is_error":false}]},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"c7b090ba-50d7-4f47-82e9-25d6fdbd8719","timestamp":"2026-09-18T18:39:08.451Z","tool_use_result":{"stdout":"hi","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}`,
  rateLimit: `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789758600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.38,"resetsAt":1789758600},"seven_day":{"utilization":0.21,"resetsAt":1790244000}}},"uuid":"f63982a5-e34c-4853-8e02-2005f4156472","session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf"}`,
  edit: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfBPi5gerbqzrNuEZHgbt","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01VQXMkppF6gUP1Rzwi7j4j8","name":"Edit","input":{"replace_all":false,"file_path":"/tmp/loopfile-24-rec-bd57d19b/ws/note.txt","old_string":"alpha","new_string":"beta"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":963,"cache_read_input_tokens":28414,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":963},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"c8d889e7-e3ef-4727-a769-19646cbc75a8","timestamp":"2026-09-18T18:39:10.778Z","request_id":"req_011CfBPi5AtY7LVUGNeCENdC","wire_tool_inputs":{"toolu_01VQXMkppF6gUP1Rzwi7j4j8":{"file_path":"/tmp/loopfile-24-rec-bd57d19b/ws/note.txt","old_string":"alpha","new_string":"beta"}}}`,
  text: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfBPiDPkE31QKvq91JvLn","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":270,"cache_read_input_tokens":29377,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":270},"output_tokens":2,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"fd6f1a6d-b590-449b-b917-03d04d0a99c8","timestamp":"2026-09-18T18:39:12.144Z","request_id":"req_011CfBPiCqkkTFV5v5Tv9Xfj"}`,
  result: `{"duration_api_ms":7439,"stop_reason":"end_turn","session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","total_cost_usd":0.04195220000000001,"usage":{"input_tokens":26,"cache_creation_input_tokens":15946,"cache_read_input_tokens":71492,"output_tokens":577,"output_tokens_details":{"thinking_tokens":326},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":15946,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":8,"output_tokens":71,"cache_read_input_tokens":29377,"cache_creation_input_tokens":270,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":270},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":26,"outputTokens":577,"cacheReadInputTokens":71492,"cacheCreationInputTokens":15946,"webSearchRequests":0,"costUSD":0.04195220000000001,"contextWindow":200000,"maxOutputTokens":32000,"thinkingTokens":326,"canonicalModel":"claude-haiku-4-5","provider":"firstParty","costBasis":"list"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":false,"num_turns":4,"subtype":"success","api_error_status":null,"result":"ok","ttft_ms":3232,"type":"result","duration_ms":7633,"uuid":"e3848d49-3dc8-4255-a057-eae2328a39e0","ttft_stream_ms":887,"time_to_request_ms":140,"first_content_frame_ms":888,"queued_turn_count":0,"result_index":0}`,
};

/** A short assistant line with the given content blocks. */
function assistant(...content: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { content } });
}

function tool(name: string, input: unknown): string {
  return assistant({ type: "tool_use", id: "toolu_1", name, input });
}

function result(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", ...fields });
}

test("with no args, model or effort, the argument list is exactly the adapter's", () => {
  const prepared = claudeAdapter.prepare(call);
  assert.equal(prepared.command, "claude");
  assert.deepEqual(prepared.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    `${attempt}/wiring/settings.json`,
  ]);
});

test("args come first, and --model then --effort come last", () => {
  const prepared = claudeAdapter.prepare({
    ...call,
    args: ["--strict-mcp-config"],
    model: "sonnet",
    effort: "high",
  });
  assert.deepEqual(prepared.args, [
    "--strict-mcp-config",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    `${attempt}/wiring/settings.json`,
    "--model",
    "sonnet",
    "--effort",
    "high",
  ]);
});

test("a model alone gives --model and no --effort", () => {
  const { args } = claudeAdapter.prepare({ ...call, model: "opus" });
  assert.deepEqual(args.slice(-2), ["--model", "opus"]);
  assert.equal(args.includes("--effort"), false);
});

test("the prompt is in stdin and in no argument, and no argument is --bare", () => {
  const { args, stdin } = claudeAdapter.prepare({ ...call, args: ["--add-dir", "/other"] });
  assert.equal(stdin, call.prompt);
  assert.equal(
    args.some((arg) => arg.includes(call.prompt)),
    false,
  );
  assert.equal(args.includes("--bare"), false);
});

test("settings.json allows the step commands, the scratch folder and the attempt socket", () => {
  const { wiringFiles } = claudeAdapter.prepare(call);
  assert.deepEqual(JSON.parse(wiringFiles["settings.json"] as string), {
    permissions: {
      allow: ["Bash(loopfile data *)", "Bash(loopfile result *)"],
      additionalDirectories: [`${attempt}/scratch`],
      defaultMode: "acceptEdits",
    },
    sandbox: {
      excludedCommands: ["loopfile *"],
      network: { allowUnixSockets: [`${attempt}/sock`] },
      filesystem: { allowWrite: [`${attempt}/scratch`] },
    },
  });
});

test("the only wiring file is settings.json, and no path points into the workspace", () => {
  const prepared = claudeAdapter.prepare({ ...call, model: "sonnet", effort: "high" });
  assert.deepEqual(Object.keys(prepared.wiringFiles), ["settings.json"]);
  const written = JSON.stringify([prepared.args, prepared.wiringFiles]);
  assert.equal(written.includes(context.workspace), false);
});

test("recorded lines give tool, progress, and nothing for the rest", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  assert.deepEqual(parseStdoutLine(recorded.bash), [
    { kind: "tool", tool: "Bash", target: "echo hi" },
  ]);
  assert.deepEqual(parseStdoutLine(recorded.edit), [
    { kind: "tool", tool: "Edit", target: "note.txt" },
  ]);
  assert.deepEqual(parseStdoutLine(recorded.text), [{ kind: "progress", text: "ok" }]);
  for (const line of [recorded.thinking, recorded.system, recorded.user, recorded.rateLimit]) {
    assert.deepEqual(parseStdoutLine(line), [], line.slice(0, 40));
  }
  for (const line of ["not json", "", "{", "null", "42", '"text"', "[]"]) {
    assert.deepEqual(parseStdoutLine(line), [], line);
  }
});

test("the recorded result line gives the call's metrics, cached input included", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  parseStdoutLine(recorded.bash);
  parseStdoutLine(recorded.edit);
  parseStdoutLine(recorded.text);
  assert.deepEqual(parseStdoutLine(recorded.result), [
    {
      kind: "metrics",
      metrics: {
        inputTokens: 26 + 15946 + 71492,
        outputTokens: 577,
        totalTokens: 26 + 15946 + 71492 + 577,
        costUsd: 0.04195220000000001,
        toolCalls: 2,
      },
    },
  ]);
});

test("a result with no usage and no cost gives null tokens and cost, and keeps toolCalls", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  parseStdoutLine(recorded.bash);
  assert.deepEqual(parseStdoutLine(result({})), [
    {
      kind: "metrics",
      metrics: {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        toolCalls: 1,
      },
    },
  ]);
});

test("a reported 0 stays 0", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  const usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  assert.deepEqual(parseStdoutLine(result({ usage, total_cost_usd: 0 })), [
    {
      kind: "metrics",
      metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, toolCalls: 0 },
    },
  ]);
});

test("input tokens are null when one of the 3 input counts is not a number", () => {
  const full = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 };
  for (const missing of Object.keys(full)) {
    const usage: Record<string, unknown> = { ...full, output_tokens: 5, [missing]: "7" };
    const { parseStdoutLine } = claudeAdapter.prepare(call);
    assert.deepEqual(parseStdoutLine(result({ usage })), [
      {
        kind: "metrics",
        metrics: {
          inputTokens: null,
          outputTokens: 5,
          totalTokens: null,
          costUsd: null,
          toolCalls: 0,
        },
      },
    ]);
  }
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  assert.deepEqual(parseStdoutLine(result({ usage: full })), [
    {
      kind: "metrics",
      metrics: {
        inputTokens: 6,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        toolCalls: 0,
      },
    },
  ]);
});

test("2 prepare calls do not share a tool counter", () => {
  const first = claudeAdapter.prepare(call);
  const second = claudeAdapter.prepare(call);
  first.parseStdoutLine(recorded.bash);
  first.parseStdoutLine(recorded.edit);
  second.parseStdoutLine(recorded.bash);
  const toolCalls = (line: readonly unknown[]) =>
    (line[0] as { metrics: { toolCalls: number } }).metrics.toolCalls;
  assert.equal(toolCalls(first.parseStdoutLine(result({}))), 2);
  assert.equal(toolCalls(second.parseStdoutLine(result({}))), 1);
});

test("one assistant line gives an activity for each tool and text block, in order", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  const line = assistant(
    { type: "text", text: "Reading it." },
    { type: "thinking", thinking: "hmm" },
    { type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } },
    { type: "tool_use", name: "Grep", input: { pattern: "TODO" } },
  );
  assert.deepEqual(parseStdoutLine(line), [
    { kind: "progress", text: "Reading it." },
    { kind: "tool", tool: "Read", target: "/etc/hosts" },
    { kind: "tool", tool: "Grep", target: "TODO" },
  ]);
  assert.deepEqual(
    parseStdoutLine(result({})).map((a) => a.kind === "metrics" && a.metrics.toolCalls),
    [2],
  );
});

test("an assistant line with no content list gives nothing", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  for (const line of [
    JSON.stringify({ type: "assistant" }),
    JSON.stringify({ type: "assistant", message: { content: "text" } }),
    assistant(null, "text", 3),
  ]) {
    assert.deepEqual(parseStdoutLine(line), [], line);
  }
});

test("each known tool takes its target from its own input field", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  const cases: [string, Record<string, unknown>, string][] = [
    ["Bash", { command: "npm test", description: "Run tests" }, "npm test"],
    ["Read", { file_path: `${context.workspace}/src/a.ts` }, "src/a.ts"],
    ["Write", { file_path: `${context.workspace}/b.md`, content: "x" }, "b.md"],
    ["NotebookEdit", { notebook_path: `${context.workspace}/n.ipynb` }, "n.ipynb"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["Grep", { pattern: "TODO", path: "/x" }, "TODO"],
    ["WebFetch", { url: "https://example.com", prompt: "p" }, "https://example.com"],
    ["WebSearch", { query: "node test runner" }, "node test runner"],
    ["Task", { description: "Find callers", prompt: "p" }, "Find callers"],
    ["Agent", { description: "Review", prompt: "p" }, "Review"],
  ];
  for (const [name, input, target] of cases) {
    assert.deepEqual(
      parseStdoutLine(tool(name, input)),
      [{ kind: "tool", tool: name, target }],
      name,
    );
  }
});

test("an unknown tool, a field that is not a string, or no input gives an empty target", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  const cases: [string, unknown][] = [
    ["mcp__github__create_issue", { title: "x" }],
    ["constructor", { command: "x" }],
    ["Bash", { command: ["echo", "hi"] }],
    ["Read", { file_path: 7 }],
    ["Bash", "echo hi"],
    ["Bash", undefined],
  ];
  for (const [name, input] of cases) {
    assert.deepEqual(
      parseStdoutLine(tool(name, input)),
      [{ kind: "tool", tool: name, target: "" }],
      name,
    );
  }
});

test("a file path outside the workspace stays as the harness gave it", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  const target = (path: string) => {
    const [activity] = parseStdoutLine(tool("Edit", { file_path: path }));
    return activity?.kind === "tool" ? activity.target : undefined;
  };
  assert.equal(target("/etc/hosts"), "/etc/hosts");
  assert.equal(target(`${context.workspace}2/a.ts`), `${context.workspace}2/a.ts`);
  assert.equal(target(context.workspace), context.workspace);
  assert.equal(target("relative/a.ts"), "relative/a.ts");
  assert.equal(target(`${context.workspace}/..leading-dots.ts`), "..leading-dots.ts");
});

const settingsOf = (args: string[]) => {
  const { wiringFiles } = claudeAdapter.prepare({ ...call, args });
  return JSON.parse(wiringFiles["settings.json"] as string);
};

test("a user's --settings is merged into the adapter's file, and only one --settings is sent", () => {
  const user = JSON.stringify({
    enabledPlugins: { "p@m": true },
    includeCoAuthoredBy: false,
    permissions: { allow: ["Bash(git *)", "Bash(loopfile data *)"], defaultMode: "plan" },
  });
  for (const args of [
    ["--settings", user, "--add-dir", "/x"],
    [`--settings=${user}`, "--add-dir", "/x"],
  ]) {
    const prepared = claudeAdapter.prepare({ ...call, args });
    assert.equal(prepared.args.filter((a) => a.startsWith("--settings")).length, 1);
    assert.deepEqual(prepared.args.slice(0, 2), ["--add-dir", "/x"]);
    assert.ok(prepared.args.includes(`${attempt}/wiring/settings.json`));
    const merged = settingsOf(args);
    assert.deepEqual(merged.enabledPlugins, { "p@m": true });
    assert.equal(merged.includeCoAuthoredBy, false);
    assert.equal(merged.permissions.defaultMode, "plan");
    assert.deepEqual(merged.permissions.allow, [
      "Bash(loopfile data *)",
      "Bash(loopfile result *)",
      "Bash(git *)",
    ]);
    assert.deepEqual(merged.sandbox.excludedCommands, ["loopfile *"]);
  }
});

test("two user --settings flags merge, and a bad value is an error", () => {
  const merged = settingsOf(["--settings", '{"a":1}', "--settings", '{"b":{"c":2}}']);
  assert.equal(merged.a, 1);
  assert.deepEqual(merged.b, { c: 2 });
  for (const bad of [
    ["--settings"],
    ["--settings", "/some/file.json"],
    ["--settings", "[1]"],
    ["--settings", "null"],
  ]) {
    assert.throws(() => claudeAdapter.prepare({ ...call, args: bad }), /inline JSON that is a map/);
  }
});
