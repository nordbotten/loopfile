import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStep, Workflow } from "../domain/model.ts";
import { loadWorkflow } from "./load-workflow.ts";
import { renderTrustPrompt } from "./trust-prompt.ts";

const sha = "1234567890abcdef1234567890abcdef12345678";
const modelExpression = `\${triage.model}`;
const effortExpression = `\${triage.effort}`;
const profileExpression = `implement.\${triage.complexity ?? "medium"}`;

const workflow: Workflow = {
  formatVersion: 1,
  inputs: {},
  steps: [
    {
      id: "one",
      kind: "command",
      run: "echo one",
      on: {},
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 5,
      timeoutMs: 60_000,
    },
    {
      id: "many",
      kind: "command",
      run: "printf first\nprintf second",
      on: {},
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 5,
      timeoutMs: 60_000,
    },
    {
      id: "review",
      kind: "agent",
      harness: "pi",
      model: "gpt-5.5",
      args: ["--fast", "--quiet"],
      promptFile: "review.md",
      on: { done: "$success" },
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 5,
      timeoutMs: 60_000,
    },
    {
      id: "inspect",
      kind: "agent",
      harness: "claude",
      args: [],
      promptFile: "inspect.md",
      on: { done: "$success" },
      onFailure: "$failure",
      outputs: {},
      maxAttempts: 5,
      timeoutMs: 60_000,
    },
  ],
};

const githubRemote = {
  host: "github.com",
  repo: "acme/loops",
  path: "tasks",
  ref: "release",
  sha,
};

function agentStep(fields: Partial<AgentStep> = {}): AgentStep {
  const review = workflow.steps.find((step) => step.id === "review");
  assert.ok(review && review.kind === "agent");
  return { ...review, harness: "claude", model: undefined, effort: undefined, ...fields };
}

function renderSteps(...steps: Workflow["steps"]): string {
  return renderTrustPrompt(
    { ...workflow, steps },
    githubRemote,
    "github:Acme/Loops/tasks@release",
    false,
  );
}

test("renderTrustPrompt snapshots colored and plain GitHub summaries", () => {
  assert.equal(
    renderTrustPrompt(workflow, githubRemote, "github:Acme/Loops/tasks@release", true),
    [
      "\x1b[1;91;40m DANGER  This Loopfile can run any shell command and any agent in your workspace, as you. \x1b[0m",
      "\x1b[1;91;40m Trust it only if you trust the people who can push to it.                              \x1b[0m",
      "",
      "\x1b[33m?\x1b[0m Trust this Remote Loopfile?",
      "",
      "  Source   github:Acme/Loops/tasks@release",
      `  Commit   ${sha}  (release)`,
      "  Steps    4",
      "    one        command  runs: echo one",
      "    many       command  runs: printf first\x1b[2m …\x1b[0m",
      "    review     agent    pi gpt-5.5",
      `                        \x1b[33margs:\x1b[0m --fast --quiet`,
      "    inspect    agent    claude -",
      "",
      `  Full text: \x1b[2mloopfile unpack github:acme/loops/tasks@${sha.slice(0, 7)} ./look\x1b[0m`,
    ].join("\n"),
  );
  assert.equal(
    renderTrustPrompt(workflow, githubRemote, "github:Acme/Loops/tasks@release", false),
    [
      "DANGER  This Loopfile can run any shell command and any agent in your workspace, as you.",
      "Trust it only if you trust the people who can push to it.",
      "",
      "? Trust this Remote Loopfile?",
      "",
      "  Source   github:Acme/Loops/tasks@release",
      `  Commit   ${sha}  (release)`,
      "  Steps    4",
      "    one        command  runs: echo one",
      "    many       command  runs: printf first …",
      "    review     agent    pi gpt-5.5",
      "                        args: --fast --quiet",
      "    inspect    agent    claude -",
      "",
      `  Full text: loopfile unpack github:acme/loops/tasks@${sha.slice(0, 7)} ./look`,
    ].join("\n"),
  );
});

test("a step with model and effort shows effort in parentheses", () => {
  assert.match(
    renderSteps(agentStep({ model: "opus", effort: "high" })),
    /review\s+agent\s+claude opus \(high\)/,
  );
});

test("model-only and effort-only steps omit only the missing field", () => {
  const summary = (fields: Partial<AgentStep>) =>
    renderSteps(agentStep(fields))
      .split("\n")
      .find((line) => line.includes("review"));
  assert.match(summary({ model: "opus" }) ?? "", /claude opus$/);
  assert.match(summary({ effort: "high" }) ?? "", /claude - \(high\)$/);
  assert.match(summary({}) ?? "", /claude -$/);
});

test("field expressions appear as written in the step summary", () => {
  const prompt = renderSteps(agentStep({ model: modelExpression, effort: effortExpression }));
  assert.ok(prompt.includes(`claude ${modelExpression} (${effortExpression})`));
});

test("a step profile appears as written in the step summary", () => {
  assert.ok(
    renderSteps(agentStep({ profile: profileExpression })).includes(`profile ${profileExpression}`),
  );
});

test("agent and Ralph steps show the same harness, field expressions and profile", () => {
  const fields = { model: modelExpression, effort: effortExpression, profile: profileExpression };
  const agent = agentStep({ id: "agent", ...fields });
  const ralph = {
    ...agentStep({ id: "ralph", ...fields }),
    kind: "ralph" as const,
    maxIterations: 2,
  };
  const prompt = renderSteps(agent, ralph);
  const detail = `claude ${modelExpression} (${effortExpression}) profile ${profileExpression}`;
  for (const id of ["agent", "ralph"]) {
    assert.ok(
      prompt
        .split("\n")
        .find((line) => line.startsWith(`    ${id}`))
        ?.endsWith(detail),
    );
  }
});

test("field expressions and profiles do not add a trust warning", () => {
  const loaded = loadWorkflow(
    {
      formatVersion: 1,
      inputs: { model: "model", effort: "effort", complexity: "profile" },
      profiles: {
        implement: {
          high: {
            harness: "claude",
            model: `\${input.model}`,
            effort: `\${input.effort}`,
          },
        },
      },
      steps: [
        {
          id: "work",
          kind: "agent",
          profile: `implement.\${input.complexity ?? "high"}`,
          prompt: "Work.",
          on: { done: "$success" },
        },
      ],
    },
    { root: null },
  );
  assert.equal(loaded.status, "loaded", JSON.stringify(loaded));
  if (loaded.status !== "loaded") return;
  const prompt = renderTrustPrompt(
    loaded.workflow,
    githubRemote,
    "github:Acme/Loops/tasks@release",
    false,
  );
  assert.equal(prompt.split("\n").filter((line) => /warning/i.test(line)).length, 0);
  assert.equal(prompt.split("\n").filter((line) => line.startsWith("DANGER")).length, 1);
  assert.equal(
    prompt.split("\n").filter((line) => line.startsWith("Trust it only if you trust")).length,
    1,
  );
});

test("Profiles lists each declared profile once with its full details", () => {
  const loaded = loadWorkflow(
    {
      formatVersion: 1,
      profiles: {
        implement: {
          high: {
            harness: "claude",
            model: "opus",
            effort: "high",
            args: ["--flag", "with space"],
          },
        },
        shell: { check: { run: "echo first\necho second" } },
      },
      steps: [
        {
          id: "one",
          kind: "agent",
          profile: "implement.high",
          prompt: "Work.",
          on: { done: "two" },
        },
        {
          id: "two",
          kind: "agent",
          profile: "implement.high",
          prompt: "Work.",
          on: { done: "check" },
        },
        { id: "check", kind: "command", profile: "shell.check" },
      ],
    },
    { root: null },
  );
  assert.equal(loaded.status, "loaded", JSON.stringify(loaded));
  if (loaded.status !== "loaded") return;
  const prompt = renderTrustPrompt(
    loaded.workflow,
    githubRemote,
    "github:Acme/Loops/tasks@release",
    false,
  );
  const profiles = prompt.split("\n  Profiles\n")[1]?.split("\n\n")[0] ?? "";
  assert.match(profiles, /implement\.high\s+claude opus \(high\)/);
  assert.match(profiles, /args: --flag with space/);
  assert.ok(profiles.includes("shell.check          - -"));
  assert.ok(profiles.includes("runs: echo first …"));
  assert.equal(profiles.match(/implement\.high/g)?.length, 1);
  assert.equal(profiles.match(/shell\.check/g)?.length, 1);
});

test("renderTrustPrompt snapshots git+ canonical text and the default branch", () => {
  const remote = {
    host: "git.example.test",
    repo: "org/repo",
    path: "folder",
    sha,
  };
  const singleStep: Workflow = { ...workflow, steps: workflow.steps.slice(0, 1) };
  assert.equal(
    renderTrustPrompt(
      singleStep,
      remote,
      "git+ssh://git.example.test/org/repo#subdirectory=folder",
      false,
    ),
    [
      "DANGER  This Loopfile can run any shell command and any agent in your workspace, as you.",
      "Trust it only if you trust the people who can push to it.",
      "",
      "? Trust this Remote Loopfile?",
      "",
      "  Source   git+ssh://git.example.test/org/repo#subdirectory=folder",
      `  Commit   ${sha}  (default branch)`,
      "  Steps    1",
      "    one        command  runs: echo one",
      "",
      `  Full text: loopfile unpack git+ssh://git.example.test/org/repo@${sha.slice(0, 7)}#subdirectory=folder ./look`,
    ].join("\n"),
  );
});
