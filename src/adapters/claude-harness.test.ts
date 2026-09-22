import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { HarnessCall } from "../application/harness.ts";
import { applyHarnessActivity } from "../application/harness-activity.ts";
import { NO_HARNESS_DATA } from "../application/status-projection.ts";
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
  bash: `{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CfJUJowpVkjXGuNGfwskY","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01VGunVZMmJruZm3UmraSJ9z","name":"Bash","input":{"command":"gh-axi issue view 25 --comments"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":405,"cache_read_input_tokens":32940,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":405},"output_tokens":16,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"96b5ccc6-613b-444c-a111-d64895c81768","uuid":"8366613d-4b7a-4ba7-aa2d-81ab9c95426a","timestamp":"2026-09-22T12:23:38.245Z","request_id":"req_011CfJUJoLMmrivnWbB3wUuF","wire_tool_inputs":{"toolu_01VGunVZMmJruZm3UmraSJ9z":{"command":"gh-axi issue view 25 --comments"}}}`,
  denied: `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"This command requires approval","is_error":true,"tool_use_id":"toolu_01VGunVZMmJruZm3UmraSJ9z"}]},"parent_tool_use_id":null,"session_id":"96b5ccc6-613b-444c-a111-d64895c81768","uuid":"d5de49a6-fcd6-44d9-80fd-a40c392742c9","timestamp":"2026-09-22T12:23:38.250Z","tool_use_result":"Error: This command requires approval","tool_result_meta":[{"id":"toolu_01VGunVZMmJruZm3UmraSJ9z","non_execution_kind":"user-rejected"}]}`,
  user: `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01K85tZdfoaAVvi7anTPrfP9","type":"tool_result","content":"hi","is_error":false}]},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"c7b090ba-50d7-4f47-82e9-25d6fdbd8719","timestamp":"2026-09-18T18:39:08.451Z","tool_use_result":{"stdout":"hi","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}`,
  rateLimit: `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789758600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.38,"resetsAt":1789758600},"seven_day":{"utilization":0.21,"resetsAt":1790244000}}},"uuid":"f63982a5-e34c-4853-8e02-2005f4156472","session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf"}`,
  edit: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfBPi5gerbqzrNuEZHgbt","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01VQXMkppF6gUP1Rzwi7j4j8","name":"Edit","input":{"replace_all":false,"file_path":"/tmp/loopfile-24-rec-bd57d19b/ws/note.txt","old_string":"alpha","new_string":"beta"},"caller":{"type":"direct"}}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":963,"cache_read_input_tokens":28414,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":963},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"c8d889e7-e3ef-4727-a769-19646cbc75a8","timestamp":"2026-09-18T18:39:10.778Z","request_id":"req_011CfBPi5AtY7LVUGNeCENdC","wire_tool_inputs":{"toolu_01VQXMkppF6gUP1Rzwi7j4j8":{"file_path":"/tmp/loopfile-24-rec-bd57d19b/ws/note.txt","old_string":"alpha","new_string":"beta"}}}`,
  text: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CfBPiDPkE31QKvq91JvLn","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":8,"cache_creation_input_tokens":270,"cache_read_input_tokens":29377,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":270},"output_tokens":2,"service_tier":"standard","inference_geo":"not_available"},"input_transformations":[],"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"eb9c6315-e713-41fc-a6ec-dd8c77a3abdf","uuid":"fd6f1a6d-b590-449b-b917-03d04d0a99c8","timestamp":"2026-09-18T18:39:12.144Z","request_id":"req_011CfBPiCqkkTFV5v5Tv9Xfj"}`,
  result:
    String.raw`{"duration_api_ms":36973,"stop_reason":"end_turn","session_id":"96b5ccc6-613b-444c-a111-d64895c81768","total_cost_usd":0.5416464999999999,"usage":{"input_tokens":28,"cache_creation_input_tokens":24403,"cache_read_input_tokens":448453,"output_tokens":2930,"output_tokens_details":{"thinking_tokens":988},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":24403,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":475,"cache_read_input_tokens":35637,"cache_creation_input_tokens":690,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":690},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-opus-5":{"inputTokens":28,"outputTokens":2930,"cacheReadInputTokens":448453,"cacheCreationInputTokens":24403,"webSearchRequests":0,"costUSD":0.5416464999999999,"contextWindow":1000000,"maxOutputTokens":128000,"thinkingTokens":988,"canonicalModel":"claude-opus-5","provider":"firstParty","costBasis":"list"}},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01S8DxYmbAjJ6WZuY15GiTbe","tool_input":{"command":"gh issue view 25 --comments | tail -40; grep -rn \"SKILL.md\\|skills/loopfile\" src --include=*.ts | grep -v test | head"}},{"tool_name":"Bash","tool_use_id":"toolu_01N4wbQn6JZWLXfzU4q6gqJa","tool_input":{"command":"gh-axi issue view 25 --comments 2>&1 | tail -40"}},{"tool_name":"Bash","tool_use_id":"toolu_01VGunVZMmJruZm3UmraSJ9z","tool_input":{"command":"gh-axi issue view 25 --comments"}},{"tool_name":"Bash","tool_use_id":"toolu_01L8yF5oy9Sb6SRXsD4ANbNj","tool_input":{"command":"gh api repos/nordbotten/loopfile/issues/25/comments --jq '.[] | .created_at + \" \" + .body'"}},{"tool_name":"Bash","tool_use_id":"toolu_01BViFMXN9no2VTEQPFfe5Uq","tool_input":{"command":"ls -R /home/sindre/.loopfile/runs/20260922-120857-xm2n/attempts/ 2>&1 | head -40; loopfile data --help 2>&1 | head -20"}},{"tool_name":"Bash","tool_use_id":"toolu_012MgN9eyzirLS1RmUG7ZNV1","tool_input":{"command":"git -C /home/sindre/.loopfile/runs/20260922-120857-xm2n/workspace log -1 --format=%B"}},{"tool_name":"Bash","tool_use_id":"toolu_01SJcKiRVqfykg29GPYGPSdw","tool_input":{"command":"gh issue view 25 --comments"}},{"tool_name":"WebFetch","tool_use_id":"toolu_01P5T5mt7MB6FtBPdghgkGmo","tool_input":{"url":"https://github.com/nordbotten/loopfile/issues/25","prompt":"List all comments on this issue verbatim, especially any about R1 / auto mode in -p mode."}}],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":false,"num_turns":15,"subtype":"success","api_error_status":null,"result":"I sent the review back as \x60changes_requested\x60.\n\n**What blocks:** the R1 check has no proof. The issue says the agent must test that \x60auto\x60 mode works in \x60-p\x60 mode on a subscription login, and post the result on issue #25 before changing the default. Nothing on the branch mentions this test. That includes the commit message.\n\n**Where I could be wrong:** I could not read the comments on #25. The \x60gh\x60 and WebFetch calls needed approval and did not run. So a note about R1 may already be on the issue. If it is, this block is wrong, and you can approve the branch.\n\n**Everything else is met:**\n1. The adapter passes \x60--setting-sources project,local\x60 and sets \x60defaultMode: \"auto\"\x60.\n2. A test checks that \x60--permission-mode\x60 in \x60args\x60 still comes before the adapter's default.\n3. A manifest cannot set \x60--setting-sources\x60 itself. Tests check this.\n4. \x60docs/manifest-v1.md\x60 and \x60skills/loopfile/SKILL.md\x60 both explain the rules and warn about yolo mode. \x60loopfile docs\x60 prints that skill file.\n\n**Note, not blocking:** the \x60~/.claude\x60 \x60Bash(git *)\x60 case is only covered by a test that checks the flag is passed. No test runs a real \x60claude\x60.\n\n**What you do now:** if the R1 note is on #25, approve the branch. If it is not, let the loop do the check.","ttft_ms":1583,"type":"result","duration_ms":37528,"uuid":"35f24590-a1d4-4505-8cb3-574054b6df4a","ttft_stream_ms":898,"time_to_request_ms":60,"first_content_frame_ms":898,"queued_turn_count":0,"result_index":0}`.replaceAll(
      "\\x60",
      String.fromCharCode(96),
    ),
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
    "--setting-sources",
    "project,local",
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
    "--setting-sources",
    "project,local",
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

test("a permission mode in args stays ahead of the adapter settings", () => {
  const prepared = claudeAdapter.prepare({ ...call, args: ["--permission-mode", "plan"] });
  assert.deepEqual(prepared.args.slice(0, 2), ["--permission-mode", "plan"]);
  assert.equal(
    JSON.parse(prepared.wiringFiles["settings.json"] as string).permissions.defaultMode,
    "auto",
  );
});

test("settings.json allows the step commands, the scratch folder and the attempt socket", () => {
  const { wiringFiles } = claudeAdapter.prepare(call);
  assert.deepEqual(JSON.parse(wiringFiles["settings.json"] as string), {
    permissions: {
      allow: ["Bash(loopfile data *)", "Bash(loopfile result *)"],
      additionalDirectories: [`${attempt}/scratch`],
      defaultMode: "auto",
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
    { kind: "tool", tool: "Bash", target: "gh-axi issue view 25 --comments" },
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

test("a recorded denied tool result becomes a denied log line", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  parseStdoutLine(recorded.bash);
  const [activity] = parseStdoutLine(recorded.denied);
  if (activity?.kind !== "tool") throw new Error("recorded denial was not a tool activity");
  assert.deepEqual(activity, {
    kind: "tool",
    tool: "Bash",
    target: "gh-axi issue view 25 --comments",
    denied: true,
  });
  assert.equal(
    applyHarnessActivity(NO_HARNESS_DATA, activity, "2026-09-22T12:23:38.250Z").logText,
    "Bash gh-axi issue view 25 --comments (denied)",
  );
});

test("the recorded result line gives the call's metrics, cached input included", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  parseStdoutLine(recorded.bash);
  parseStdoutLine(recorded.denied);
  parseStdoutLine(recorded.edit);
  parseStdoutLine(recorded.text);
  assert.deepEqual(parseStdoutLine(recorded.result), [
    {
      kind: "metrics",
      metrics: {
        inputTokens: 28 + 24403 + 448453,
        outputTokens: 2930,
        totalTokens: 28 + 24403 + 448453 + 2930,
        costUsd: 0.5416464999999999,
        toolCalls: 2,
        permissionDenials: 8,
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
        permissionDenials: null,
      },
    },
  ]);
});

test("an empty denial list reports 0", () => {
  const { parseStdoutLine } = claudeAdapter.prepare(call);
  const [activity] = parseStdoutLine(result({ permission_denials: [] }));
  assert.equal(activity?.kind === "metrics" ? activity.metrics.permissionDenials : undefined, 0);
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
      metrics: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        toolCalls: 0,
        permissionDenials: null,
      },
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
          permissionDenials: null,
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
        permissionDenials: null,
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
