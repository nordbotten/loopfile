import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workflow } from "../domain/model.ts";
import { renderTrustPrompt } from "./trust-prompt.ts";

const sha = "1234567890abcdef1234567890abcdef12345678";

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
