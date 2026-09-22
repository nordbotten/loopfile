import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionContext } from "../application/executor.ts";
import type { HarnessCall } from "../application/harness.ts";
import { piAdapter } from "./pi-harness.ts";

const context: ExecutionContext = {
  runId: "2026-09-18-0001",
  attemptId: "001-work",
  stepId: "work",
  workspace: "/ws",
  scratch: "/a/scratch",
  endpoint: "/a/sock",
  attemptSecret: "s3cret",
};

const call: HarnessCall = {
  context,
  prompt: "Run: loopfile result done",
  args: [],
  wiringFolder: "/a/wiring",
};

const json = (value: unknown) => JSON.stringify(value);

const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cost: { total },
});

/* Lines of the shape a real `pi` 0.85.1 run wrote (openai-codex/gpt-5.5, trimmed). */
const recorded = {
  tool: `{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}`,
  toolCall: `{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"echo hi"}}],"stopReason":"toolUse","usage":{"input":5701,"output":20,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":5721,"cost":{"input":0.028505,"output":0.0006,"cacheRead":0,"cacheWrite":0,"total":0.029105}}}}`,
  text: `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","usage":{"input":101,"output":5,"cacheRead":5632,"cacheWrite":0,"reasoning":0,"totalTokens":5738,"cost":{"input":0.000505,"output":0.00015,"cacheRead":0.002816,"cacheWrite":0,"total":0.003471}}}}`,
  end: `{"type":"agent_end","messages":[],"willRetry":false}`,
};

test("with no args, model or effort the arguments are the fixed ones", () => {
  const prepared = piAdapter.prepare(call);
  assert.equal(prepared.command, "pi");
  assert.deepEqual(prepared.args, ["-p", "--mode", "json", "--no-session"]);
});

test("args come first, then the model and the thinking effort last", () => {
  const prepared = piAdapter.prepare({
    ...call,
    args: ["--provider", "openai"],
    model: "openai/gpt-5.5",
    effort: "high",
  });
  assert.deepEqual(prepared.args, [
    "--provider",
    "openai",
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--model",
    "openai/gpt-5.5",
    "--thinking",
    "high",
  ]);
});

test("a model alone and an effort alone each add only their own flag", () => {
  assert.deepEqual(piAdapter.prepare({ ...call, model: "m" }).args.slice(4), ["--model", "m"]);
  assert.deepEqual(piAdapter.prepare({ ...call, effort: "low" }).args.slice(4), [
    "--thinking",
    "low",
  ]);
});

test("the prompt is on stdin, in no argument, and there are no wiring files", () => {
  const prepared = piAdapter.prepare(call);
  assert.equal(prepared.stdin, call.prompt);
  assert.equal(
    prepared.args.some((arg) => arg.includes(call.prompt)),
    false,
  );
  assert.deepEqual(prepared.wiringFiles, {});
});

test("the recorded lines give the activities and the metrics", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  assert.deepEqual(parseStdoutLine(recorded.tool), [
    { kind: "tool", tool: "bash", target: "echo hi" },
  ]);
  assert.deepEqual(parseStdoutLine(recorded.toolCall), []);
  assert.deepEqual(parseStdoutLine(recorded.text), [{ kind: "progress", text: "ok" }]);
  const [metrics] = parseStdoutLine(recorded.end);
  assert.equal(metrics?.kind, "metrics");
  if (metrics?.kind !== "metrics") return;
  assert.equal(metrics.metrics.inputTokens, 11434);
  assert.equal(metrics.metrics.outputTokens, 25);
  assert.equal(metrics.metrics.totalTokens, 11459);
  assert.ok(Math.abs((metrics.metrics.costUsd ?? 0) - 0.032576) < 1e-9);
  assert.equal(metrics.metrics.toolCalls, 1);
});

test("targets: paths inside the workspace are relative, others stay", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  const start = (toolName: string, args: unknown) =>
    parseStdoutLine(json({ type: "tool_execution_start", toolName, args }));
  assert.deepEqual(start("read", { path: "/ws/src/a.ts" }), [
    { kind: "tool", tool: "read", target: "src/a.ts" },
  ]);
  assert.deepEqual(start("edit", { path: "/elsewhere/a.ts" }), [
    { kind: "tool", tool: "edit", target: "/elsewhere/a.ts" },
  ]);
  assert.deepEqual(start("write", { path: "/ws" }), [
    { kind: "tool", tool: "write", target: "/ws" },
  ]);
  assert.deepEqual(start("ls", { path: "/ws/../x" }), [
    { kind: "tool", tool: "ls", target: "/ws/../x" },
  ]);
  assert.deepEqual(start("write", { path: "rel.txt" }), [
    { kind: "tool", tool: "write", target: "rel.txt" },
  ]);
  assert.deepEqual(start("grep", { pattern: "foo" }), [
    { kind: "tool", tool: "grep", target: "foo" },
  ]);
  assert.deepEqual(start("find", { pattern: "*.ts" }), [
    { kind: "tool", tool: "find", target: "*.ts" },
  ]);
  assert.deepEqual(start("other", { path: "/ws/a" }), [
    { kind: "tool", tool: "other", target: "" },
  ]);
  assert.deepEqual(start("bash", { command: 5 }), [{ kind: "tool", tool: "bash", target: "" }]);
  assert.deepEqual(start("bash", undefined), [{ kind: "tool", tool: "bash", target: "" }]);
  assert.deepEqual(parseStdoutLine(json({ type: "tool_execution_start" })), [
    { kind: "tool", tool: "", target: "" },
  ]);
});

test("lines that show nothing give no activity", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  const message = (role: string, content: unknown) =>
    json({ type: "message_end", message: { role, content } });
  for (const line of [
    json({ type: "session" }),
    json({ type: "message_update" }),
    json({ type: "agent_start" }),
    json({ type: "tool_execution_end" }),
    json({}),
    message("assistant", [{ type: "thinking", thinking: "hm" }]),
    message("assistant", "text"),
    message("assistant", [null]),
    message("user", [{ type: "text", text: "hi" }]),
    message("toolResult", [{ type: "text", text: "hi" }]),
    json({ type: "message_end" }),
    "not json",
    "[1]",
  ]) {
    assert.deepEqual(parseStdoutLine(line), [], line);
  }
});

test("an error stop shows its message as progress", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  const end = (stopReason: string, errorMessage?: string) =>
    json({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason, errorMessage },
    });
  assert.deepEqual(parseStdoutLine(end("error", "rate limited")), [
    { kind: "progress", text: "rate limited" },
  ]);
  assert.deepEqual(parseStdoutLine(end("aborted", "stopped")), [
    { kind: "progress", text: "stopped" },
  ]);
  assert.deepEqual(parseStdoutLine(end("error")), []);
  assert.deepEqual(parseStdoutLine(end("stop", "note")), []);
});

test("a later agent_end replaces an earlier one with the totals of both segments", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  const end = json({ type: "agent_end" });
  const msg = (u: unknown) =>
    json({ type: "message_end", message: { role: "assistant", content: [], usage: u } });
  parseStdoutLine(`{"type":"tool_execution_start","toolName":"bash"}`);
  parseStdoutLine(msg(usage(1, 2, 3, 4, 0.5)));
  assert.deepEqual(parseStdoutLine(end), [
    {
      kind: "metrics",
      metrics: { inputTokens: 8, outputTokens: 2, totalTokens: 10, costUsd: 0.5, toolCalls: 1 },
    },
  ]);
  parseStdoutLine(msg(usage(10, 20, 30, 40, 0.25)));
  assert.deepEqual(parseStdoutLine(end), [
    {
      kind: "metrics",
      metrics: { inputTokens: 88, outputTokens: 22, totalTokens: 110, costUsd: 0.75, toolCalls: 1 },
    },
  ]);
});

test("no usage gives null fields and keeps the tool count; a reported 0 stays 0", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  parseStdoutLine(`{"type":"tool_execution_start","toolName":"bash"}`);
  parseStdoutLine(json({ type: "message_end", message: { role: "assistant", content: [] } }));
  assert.deepEqual(parseStdoutLine(json({ type: "agent_end" })), [
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
  const zero = piAdapter.prepare(call).parseStdoutLine;
  zero(json({ type: "message_end", message: { role: "assistant", usage: usage(0, 0, 0, 0, 0) } }));
  assert.deepEqual(zero(json({ type: "agent_end" })), [
    {
      kind: "metrics",
      metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, toolCalls: 0 },
    },
  ]);
});

test("each field goes null on its own", () => {
  const { parseStdoutLine } = piAdapter.prepare(call);
  parseStdoutLine(
    json({
      type: "message_end",
      message: { role: "assistant", usage: { input: 1, cacheRead: 1, output: 2 } },
    }),
  );
  assert.deepEqual(parseStdoutLine(json({ type: "agent_end" })), [
    {
      kind: "metrics",
      metrics: {
        inputTokens: null,
        outputTokens: 2,
        totalTokens: null,
        costUsd: null,
        toolCalls: 0,
      },
    },
  ]);
});

test("two prepare calls share no counter or totals", () => {
  const a = piAdapter.prepare(call);
  const b = piAdapter.prepare(call);
  a.parseStdoutLine(recorded.tool);
  a.parseStdoutLine(recorded.text);
  assert.deepEqual(b.parseStdoutLine(recorded.end), [
    {
      kind: "metrics",
      metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, toolCalls: 0 },
    },
  ]);
});
