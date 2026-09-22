import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStep } from "../domain/model.ts";
import {
  inlinePromptFile,
  type LoadOptions,
  type LoopfileRoot,
  loadWorkflow,
} from "./load-workflow.ts";

const files: Record<string, string> = { "prompts/implement.md": "Do {{ input.task }}" };
const root: LoopfileRoot = { readText: (path) => files[path] };
const options: LoadOptions = { root };

function valid(): Record<string, unknown> {
  return {
    formatVersion: 1,
    maxTransitions: 40,
    runTimeout: "8h",
    inputs: { task: "what to build" },
    steps: [
      {
        id: "implement",
        kind: "ralph",
        harness: "claude",
        model: "claude-opus-5",
        effort: "high",
        promptFile: "prompts/implement.md",
        timeout: "30m",
        maxIterations: 20,
        maxAttempts: 6,
        on: { done: "test", blocked: "$failure" },
      },
      {
        id: "test",
        kind: "command",
        run: "npm test",
        timeout: "15m",
        outputs: ["log"],
        on: { passed: "review", failed: "implement" },
        onFailure: "test",
      },
      {
        id: "review",
        kind: "agent",
        harness: "pi",
        effort: "xhigh",
        prompt: "Read {{ input.task }} and {{test.log}} and {{ review.feedback }}",
        outputs: { feedback: ["changes_requested"] },
        on: { approved: "$success", changes_requested: "implement" },
        onFailure: "review",
      },
    ],
  };
}

function errorsOf(manifest: unknown, opts: LoadOptions = options) {
  const result = loadWorkflow(manifest, opts);
  assert.equal(result.status, "invalid", JSON.stringify(result));
  return result.status === "invalid" ? result.errors : [];
}

/** Asserts exactly one error, at `path`, and returns its message. */
function only(manifest: unknown, path: string, opts: LoadOptions = options): string {
  const errors = errorsOf(manifest, opts);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0]?.path, path);
  return errors[0]?.message ?? "";
}

/** Asserts an error at `path`, and returns its message. Other errors may exist. */
function has(manifest: unknown, path: string, opts: LoadOptions = options): string {
  const found = errorsOf(manifest, opts).filter((e) => e.path === path);
  assert.equal(found.length >= 1, true, `no error at ${path}`);
  return found[0]?.message ?? "";
}

function withStep(index: number, patch: Record<string, unknown>): Record<string, unknown> {
  const manifest = valid();
  const steps = manifest.steps as Record<string, unknown>[];
  steps[index] = { ...steps[index], ...patch };
  return manifest;
}

function without(index: number, field: string): Record<string, unknown> {
  const manifest = valid();
  const steps = manifest.steps as Record<string, unknown>[];
  const step = { ...steps[index] };
  delete step[field];
  steps[index] = step;
  return manifest;
}

test("the reference-style manifest builds a model with every default filled in", () => {
  const result = loadWorkflow(valid(), options);
  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  const { workflow } = result;
  assert.equal(workflow.maxTransitions, 40);
  assert.equal(workflow.runTimeoutMs, 8 * 3_600_000);
  assert.equal(workflow.declaredRunTimeout, "8h");
  assert.deepEqual(workflow.inputs, { task: "what to build" });
  const [implement, test_, review] = workflow.steps;
  assert.deepEqual(implement, {
    id: "implement",
    kind: "ralph",
    harness: "claude",
    model: "claude-opus-5",
    effort: "high",
    args: [],
    promptFile: "prompts/implement.md",
    timeoutMs: 1_800_000,
    declaredLimits: { maxAttempts: 6, timeout: "30m" },
    maxIterations: 20,
    maxAttempts: 6,
    on: { done: "test", blocked: "$failure" },
    onFailure: "$failure",
    outputs: {},
  });
  assert.deepEqual(test_, {
    id: "test",
    kind: "command",
    run: "npm test",
    timeoutMs: 900_000,
    declaredLimits: { timeout: "15m" },
    maxAttempts: 5,
    on: { passed: "review", failed: "implement" },
    onFailure: "test",
    outputs: { log: [] },
  });
  assert.equal(review?.kind, "agent");
  assert.equal(review?.promptFile, "../prompts/review.md");
  assert.equal(inlinePromptFile("review"), "../prompts/review.md");
  assert.deepEqual(review?.outputs, { feedback: ["changes_requested"] });
});

test("a minimal manifest gets the defaults and leaves optional fields out", () => {
  const result = loadWorkflow(
    { formatVersion: 1, steps: [{ id: "a", kind: "command", run: "true" }] },
    { root: null },
  );
  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  assert.deepEqual(result.workflow, {
    formatVersion: 1,
    inputs: {},
    steps: [
      {
        id: "a",
        kind: "command",
        run: "true",
        on: {},
        onFailure: "$failure",
        outputs: {},
        maxAttempts: 5,
        timeoutMs: 3_600_000,
      },
    ],
  });
});

test("an agent step gets maxAttempts 5, and a ralph step maxIterations 10", () => {
  const manifest = valid();
  const steps = manifest.steps as Record<string, unknown>[];
  delete steps[0]?.maxIterations;
  delete steps[0]?.maxAttempts;
  const result = loadWorkflow(manifest, options);
  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  const first = result.workflow.steps[0];
  assert.equal(first?.kind === "ralph" ? first.maxIterations : 0, 10);
  assert.equal(first?.maxAttempts, 5);
  assert.equal(result.workflow.steps[2]?.maxAttempts, 5);
});

test("model and effort are left out when the manifest gives none", () => {
  const manifest = withStep(2, {});
  delete (manifest.steps as Record<string, unknown>[])[2]?.effort;
  const result = loadWorkflow(manifest, options);
  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  assert.ok(!("model" in (result.workflow.steps[2] ?? {})));
  assert.ok(!("effort" in (result.workflow.steps[2] ?? {})));
});

test("an error carries the line when the caller can locate the path", () => {
  const errors = errorsOf(withStep(1, { run: " " }), {
    root,
    locate: (path) => (path === "steps[1].run" ? 27 : undefined),
  });
  assert.deepEqual(errors, [
    { path: "steps[1].run", line: 27, message: "a command step needs a `run` that is not empty" },
  ]);
  assert.ok(!("line" in (errorsOf(withStep(1, { run: "" }))[0] ?? {})));
});

test("the manifest must be a map", () => {
  for (const bad of [null, [], "x", 3]) assert.equal(only(bad, ""), "the manifest must be a map");
});

test("formatVersion is missing, not an integer, or newer", () => {
  for (const bad of [undefined, "1", 1.5, null]) {
    const manifest = { ...valid(), formatVersion: bad };
    assert.match(only(manifest, "formatVersion"), /required and must be an integer/);
  }
  assert.match(only({ ...valid(), formatVersion: 2 }, "formatVersion"), /upgrade loopfile/);
});

test("an older formatVersion is not an error", () => {
  for (const version of [0, -3]) {
    assert.deepEqual(loadWorkflow({ formatVersion: version }, options), {
      status: "older",
      formatVersion: version,
    });
  }
});

test("an unknown top-level field is an error", () => {
  assert.match(only({ ...valid(), name: "x" }, "name"), /unknown field `name`/);
});

test("steps must be a list of at least one step", () => {
  for (const steps of [undefined, [], {}, "x"]) {
    assert.match(only({ ...valid(), steps }, "steps"), /at least one step/);
  }
});

test("a step must be a map", () => {
  const errors = errorsOf({ formatVersion: 1, steps: ["x"] });
  assert.ok(errors.some((e) => e.path === "steps[0]" && e.message === "a step must be a map"));
});

test("a step id is missing, invalid, reserved or duplicate", () => {
  for (const id of [undefined, 5, "Bad", "1a", "a".repeat(65), ""]) {
    assert.match(has(withStep(1, { id }), "steps[1].id"), /a step id is required/);
  }
  assert.match(has(withStep(1, { id: "input" }), "steps[1].id"), /reserved/);
  const dup = errorsOf(withStep(1, { id: "implement" }));
  assert.ok(dup.some((e) => e.path === "steps[1].id" && /used twice/.test(e.message)));
  assert.ok(!dup.some((e) => e.path === "steps[0].id"));
});

test("a step id of 64 characters is fine", () => {
  const id = "a".repeat(64);
  const result = loadWorkflow(
    { formatVersion: 1, steps: [{ id, kind: "command", run: "true", onFailure: id }] },
    { root: null },
  );
  assert.equal(result.status, "loaded");
});

test("kind is missing or not agent, command or ralph", () => {
  for (const kind of [undefined, "shell", 3]) {
    assert.match(only(withStep(0, { kind }), "steps[0].kind"), /agent, command or ralph/);
  }
});

test("an unknown field in a step is an error", () => {
  assert.match(only(withStep(1, { env: {} }), "steps[1].env"), /unknown field `env`/);
});

test("a field of another kind is an error", () => {
  assert.match(
    only(withStep(1, { harness: "claude" }), "steps[1].harness"),
    /not allowed on a step of kind command/,
  );
  assert.match(
    only(withStep(2, { run: "x" }), "steps[2].run"),
    /not allowed on a step of kind agent/,
  );
  assert.match(
    only(withStep(2, { maxIterations: 3 }), "steps[2].maxIterations"),
    /not allowed on a step of kind agent/,
  );
  assert.match(
    only(withStep(1, { maxIterations: 3 }), "steps[1].maxIterations"),
    /not allowed on a step of kind command/,
  );
});

test("a step nothing reaches is an error, through on, onFailure and fall-through", () => {
  const stray = { id: "stray", kind: "command", run: "true" };
  const manifest = valid();
  (manifest.steps as unknown[]).push(stray);
  assert.match(only(manifest, "steps[3]"), /step `stray` cannot be reached/);

  const viaOnFailure = valid();
  (viaOnFailure.steps as Record<string, unknown>[])[1] = {
    id: "test",
    kind: "command",
    run: "true",
    on: { ok: "$success" },
    onFailure: "review",
  };
  (viaOnFailure.steps as Record<string, unknown>[])[2] = {
    id: "review",
    kind: "command",
    run: "true",
  };
  assert.equal(loadWorkflow(viaOnFailure, options).status, "loaded");
});

test("fall-through reaches the next step of a command step with no on", () => {
  const manifest = {
    formatVersion: 1,
    steps: [
      { id: "a", kind: "command", run: "true" },
      { id: "b", kind: "command", run: "true" },
    ],
  };
  assert.equal(loadWorkflow(manifest, { root: null }).status, "loaded");
});

test("a step with on does not fall through", () => {
  const manifest = {
    formatVersion: 1,
    steps: [
      { id: "a", kind: "command", run: "true", on: { ok: "$success" } },
      { id: "b", kind: "command", run: "true" },
    ],
  };
  const result = loadWorkflow(manifest, { root: null });
  assert.equal(result.status, "invalid");
});

test("reachability follows a chain of steps back and forth", () => {
  const manifest = {
    formatVersion: 1,
    steps: [
      { id: "a", kind: "command", run: "true", on: { x: "c" } },
      { id: "b", kind: "command", run: "true", on: { x: "$success" } },
      { id: "c", kind: "command", run: "true", on: { x: "b" } },
    ],
  };
  assert.equal(loadWorkflow(manifest, { root: null }).status, "loaded");
});

test("an on or onFailure target must be a step, $success or $failure", () => {
  for (const target of ["nowhere", 3, "$done", ""]) {
    const patched = withStep(0, { on: { done: target } });
    assert.match(has(patched, "steps[0].on.done"), /a target must be a step ID/);
  }
  const onFailure = errorsOf(withStep(1, { onFailure: "nowhere" }));
  assert.ok(onFailure.some((e) => e.path === "steps[1].onFailure"));
  assert.equal(loadWorkflow(withStep(1, { onFailure: "$success" }), options).status, "loaded");
});

test("an outcome name must follow the id rule", () => {
  const errors = errorsOf(withStep(0, { on: { Done: "$success" } }));
  assert.ok(
    errors.some((e) => e.path === "steps[0].on.Done" && /outcome name `Done`/.test(e.message)),
  );
});

test("on must be a map", () => {
  assert.match(only(withStep(0, { on: ["x"] }), "steps[0].on"), /must be a map/);
  assert.match(only(withStep(1, { on: "x" }), "steps[1].on"), /must be a map/);
});

test("an agent or ralph step needs on, but a command step does not", () => {
  for (const index of [0, 2]) {
    for (const on of [undefined, {}]) {
      const patched = withStep(index, { on });
      assert.match(has(patched, `steps[${index}].on`), /needs `on`/);
    }
  }
  assert.equal(loadWorkflow(without(1, "on"), options).status, "loaded");
});

test("exactly one of prompt and promptFile", () => {
  assert.match(only(withStep(0, { prompt: "x" }), "steps[0]"), /exactly one/);
  assert.match(only(without(0, "promptFile"), "steps[0]"), /exactly one/);
  assert.match(only(withStep(2, { prompt: "" }), "steps[2].prompt"), /not empty/);
  assert.match(only(withStep(2, { prompt: " \n" }), "steps[2].prompt"), /not empty/);
  assert.match(only(withStep(2, { prompt: 4 }), "steps[2].prompt"), /not empty/);
});

test("harness is missing or not in the table", () => {
  for (const harness of [undefined, "codex", "constructor", 3]) {
    assert.match(only(withStep(0, { harness }), "steps[0].harness"), /one of: claude, pi/);
  }
});

test("effort must be allowed for the harness", () => {
  assert.match(
    only(withStep(0, { effort: "xhigh" }), "steps[0].effort"),
    /for claude must be one of: low, medium, high, max/,
  );
  assert.match(only(withStep(2, { effort: "ultra" }), "steps[2].effort"), /for pi must be one of/);
  assert.match(only(withStep(0, { effort: 3 }), "steps[0].effort"), /for claude/);
  assert.equal(loadWorkflow(withStep(2, { effort: "off" }), options).status, "loaded");
});

test("a bad harness reports the harness only, not effort", () => {
  const errors = errorsOf(withStep(0, { harness: "codex", effort: "medium" }));
  assert.deepEqual(
    errors.map((e) => e.path),
    ["steps[0].harness"],
  );
  assert.equal(errorsOf(withStep(0, { harness: "codex" })).length, 1);
});

test("model must be a string and is not checked otherwise", () => {
  assert.match(only(withStep(0, { model: 3 }), "steps[0].model"), /must be a string/);
  assert.equal(loadWorkflow(withStep(0, { model: "anything-goes" }), options).status, "loaded");
});

test("promptFile: absolute, outside, missing, empty, thin", () => {
  const path = "steps[0].promptFile";
  for (const value of ["/etc/passwd", "\\x", "C:\\x", "c:/x"]) {
    assert.match(only(withStep(0, { promptFile: value }), path), /relative, not absolute/);
  }
  for (const value of ["../x.md", "a/../../x.md", "a\\..\\..\\x", ".", ".."]) {
    assert.match(only(withStep(0, { promptFile: value }), path), /stay inside/);
  }
  assert.match(only(withStep(0, { promptFile: "prompts/none.md" }), path), /not in the Loopfile/);
  assert.match(only(withStep(0, { promptFile: "" }), path), /must be a path/);
  assert.match(only(withStep(0, { promptFile: 4 }), path), /must be a path/);
  assert.match(only(valid(), path, { root: null }), /thin \.loop/);
});

test("promptFile inside the root is normalized, and an empty file exists", () => {
  files["prompts/empty.md"] = "";
  for (const [value, expected] of [
    ["./prompts/implement.md", "prompts/implement.md"],
    ["prompts/../prompts/implement.md", "prompts/implement.md"],
    ["prompts/empty.md", "prompts/empty.md"],
  ] as const) {
    const result = loadWorkflow(withStep(0, { promptFile: value }), options);
    assert.equal(result.status, "loaded", value);
    assert.equal(
      result.status === "loaded"
        ? result.workflow.steps[0]?.kind === "ralph" && result.workflow.steps[0].promptFile
        : "",
      expected,
    );
  }
  delete files["prompts/empty.md"];
});

test("a thin .loop can still use an inline prompt", () => {
  const manifest = {
    formatVersion: 1,
    steps: [{ id: "a", kind: "agent", harness: "claude", prompt: "hi", on: { ok: "$success" } }],
  };
  assert.equal(loadWorkflow(manifest, { root: null }).status, "loaded");
});

test("run is missing, empty or whitespace-only", () => {
  for (const run of [undefined, "", "  \n\t", 3]) {
    assert.match(only(withStep(1, { run }), "steps[1].run"), /needs a `run`/);
  }
});

test("outputs: names must follow the id rule, in both forms", () => {
  assert.match(has(withStep(1, { outputs: ["Bad"] }), "steps[1].outputs[0]"), /output name/);
  assert.match(has(withStep(1, { outputs: ["a", 3] }), "steps[1].outputs[1]"), /output name/);
  assert.match(has(withStep(2, { outputs: { Bad: [] } }), "steps[2].outputs.Bad"), /output name/);
});

test("outputs must be a list or a map", () => {
  assert.match(has(withStep(1, { outputs: "log" }), "steps[1].outputs"), /list of names or a map/);
});

test("the map form of outputs needs on", () => {
  const manifest = withStep(1, { outputs: { log: [] } });
  delete (manifest.steps as Record<string, unknown>[])[1]?.on;
  assert.match(has(manifest, "steps[1].outputs"), /map form/);
  const list = withStep(1, { outputs: ["log"] });
  delete (list.steps as Record<string, unknown>[])[1]?.on;
  assert.equal(loadWorkflow(list, options).status, "loaded");
});

test("a map-form outcome must be a key of on", () => {
  const message = only(
    withStep(2, { outputs: { feedback: ["nope"] } }),
    "steps[2].outputs.feedback",
  );
  assert.match(message, /`nope` is not a key of `on`/);
  assert.match(
    only(withStep(2, { outputs: { feedback: "approved" } }), "steps[2].outputs.feedback"),
    /must list the outcomes/,
  );
  assert.match(
    only(withStep(2, { outputs: { feedback: ["constructor"] } }), "steps[2].outputs.feedback"),
    /not a key/,
  );
  assert.match(
    only(withStep(2, { outputs: { feedback: [3] } }), "steps[2].outputs.feedback"),
    /`3` is not a key/,
  );
});

test("maxAttempts, maxIterations and maxTransitions are integers of 1 or more", () => {
  for (const bad of [0, -1, 1.5, "3", null, Number.NaN]) {
    assert.match(
      only(withStep(0, { maxAttempts: bad }), "steps[0].maxAttempts"),
      /integer of 1 or more/,
    );
    assert.match(
      only(withStep(0, { maxIterations: bad }), "steps[0].maxIterations"),
      /integer of 1 or more/,
    );
    assert.match(
      only({ ...valid(), maxTransitions: bad }, "maxTransitions"),
      /integer of 1 or more/,
    );
  }
  const one = withStep(0, { maxAttempts: 1, maxIterations: 1 });
  assert.equal(loadWorkflow({ ...one, maxTransitions: 1 }, options).status, "loaded");
});

test("timeout and runTimeout are positive durations with unit s, m or h", () => {
  for (const bad of ["0s", "0.0m", "30", "30d", "1h30m", "-1s", "", 30, null]) {
    assert.match(only(withStep(0, { timeout: bad }), "steps[0].timeout"), /positive duration/);
    assert.match(only({ ...valid(), runTimeout: bad }, "runTimeout"), /positive duration/);
  }
});

test("durations convert to milliseconds", () => {
  const manifest = { ...withStep(0, { timeout: "2m" }), runTimeout: "1.5s" };
  const result = loadWorkflow(manifest, options);
  assert.equal(result.status, "loaded");
  if (result.status !== "loaded") return;
  assert.equal(result.workflow.runTimeoutMs, 1500);
  assert.equal(result.workflow.steps[0]?.timeoutMs, 120_000);
  const secs = loadWorkflow(withStep(0, { timeout: "90s" }), options);
  assert.equal(secs.status === "loaded" && secs.workflow.steps[0]?.timeoutMs, 90_000);
});

test("inputs: names follow the id rule and descriptions are strings", () => {
  assert.match(has({ ...valid(), inputs: [] }, "inputs"), /must be a map/);
  assert.match(has({ ...valid(), inputs: "x" }, "inputs"), /must be a map/);
  assert.match(has({ ...valid(), inputs: { task: 3 } }, "inputs.task"), /must be a string/);
  const errors = errorsOf({ ...valid(), inputs: { Task: "x", task: "y" } });
  assert.ok(errors.some((e) => e.path === "inputs.Task" && /input name `Task`/.test(e.message)));
});

test("a Handlebars prompt error names its prompt file and prompt line", () => {
  const inline = has(withStep(2, { prompt: "one\n{{ input.nope }}" }), "steps[2].prompt");
  assert.match(inline, /^\.\.\/prompts\/review\.md:2: /);
  const inBlock = errorsOf(withStep(2, { prompt: "{{#with review}}\n{{nope}}\n{{/with}}" }));
  assert.ok(inBlock.some((error) => /review\.nope/.test(error.message)));

  for (const [prompt, feature] of [
    ["{{lookup input.task input.task}}", "lookup"],
    ["{{log input.task}}", "log"],
    ["{{> partial}}", "partials"],
    ['{{#*inline "partial"}}x{{/inline}}', "inline partials"],
    ["{{*decorator}}", "decorators"],
    ["{{#if input.task}}", "does not parse"],
  ]) {
    const message = has(withStep(2, { prompt }), "steps[2].prompt");
    assert.match(message, /^\.\.\/prompts\/review\.md:1: /);
    assert.match(message, new RegExp(feature ?? ""));
  }

  files["prompts/implement.md"] = "one\n{{ input.nope }}";
  try {
    assert.match(only(valid(), "steps[0].promptFile"), /^prompts\/implement\.md:2: /);
  } finally {
    files["prompts/implement.md"] = "Do {{ input.task }}";
  }
});

test("$run.attempt accepts its documented fields and refuses an unknown one", () => {
  assert.equal(
    loadWorkflow(
      withStep(2, {
        prompt:
          "{{ $run.attempt.number }} {{ $run.attempt.lastAttempt }} {{ $run.attempt.iteration }} {{ $run.attempt.maxIterations }} {{ $run.attempt.lastIteration }} {{ $run.attempt.previousIteration.number }} {{ $run.attempt.previousIteration.reason }}",
      }),
      options,
    ).status,
    "loaded",
  );
  assert.match(
    only(withStep(2, { prompt: "{{ $run.attempt.nope }}" }), "steps[2].prompt"),
    /\$run\.attempt\.nope/,
  );
});

test("$run accepts documented fields and rejects unknown ones, including attempt items", () => {
  assert.equal(
    loadWorkflow(
      withStep(2, {
        prompt:
          "{{ $run.runId }} {{ $run.loopfileName }} {{ $run.startedAt }} {{ $run.repositoryPath }} {{ $run.branch }} {{ $run.baseCommit }} {{ $run.transitions }} {{ $run.maxTransitions }} {{ $run.runTimeout }} {{#each $run.attempts}}{{ stepId }} {{ attemptId }} {{ number }} {{ result }} {{ reason }} {{ outcome }} {{ message }} {{ startedAt }} {{ index }} {{ newest }}{{/each}}",
      }),
      options,
    ).status,
    "loaded",
  );
  assert.match(only(withStep(2, { prompt: "{{ $run.nope }}" }), "steps[2].prompt"), /\$run\.nope/);
  assert.match(
    only(withStep(2, { prompt: "{{#each $run.attempts}}{{ nope }}{{/each}}" }), "steps[2].prompt"),
    /\$run\.attempts\.nope/,
  );
  assert.match(only(withStep(2, { prompt: "{{ plan.runId }}" }), "steps[2].prompt"), /plan\.runId/);
});

test("$run.previous permits declared handoffs but rejects undeclared ones", () => {
  assert.equal(
    loadWorkflow(withStep(2, { prompt: "{{ $run.previous.data.review.feedback }}" }), options)
      .status,
    "loaded",
  );
  assert.match(
    only(withStep(2, { prompt: "{{ $run.previous.data.review.nope }}" }), "steps[2].prompt"),
    /\$run\.previous\.data\.review\.nope/,
  );
});

test("a plain map name is unknown, and each items have no fields", () => {
  assert.match(
    only(withStep(2, { prompt: "{{ review }}" }), "steps[2].prompt"),
    /`\{\{ review \}\}` is neither a declared input nor a step output/,
  );
  assert.match(
    only(withStep(2, { prompt: "{{#each review}}{{feedback}}{{/each}}" }), "steps[2].prompt"),
    /`\{\{ feedback \}\}` is neither a declared input nor a step output/,
  );
  assert.equal(
    loadWorkflow(
      withStep(2, { prompt: "{{#each review}}{{this}}{{@index}}{{../input.task}}{{/each}}" }),
      options,
    ).status,
    "loaded",
  );
  assert.match(
    only(withStep(2, { prompt: "{{#each review}}{{input.task}}{{/each}}" }), "steps[2].prompt"),
    /neither a declared input nor a step output/,
  );
});

test("a history key must be a declared input or step output", () => {
  assert.equal(
    loadWorkflow(
      withStep(2, {
        prompt: "{{#each $history.review.nope}}{{ value }}{{/each}}",
      }),
      options,
    ).status,
    "invalid",
  );
  assert.equal(
    loadWorkflow(
      withStep(2, {
        prompt:
          "{{#each $history.review.feedback}}{{ value }} {{ attemptId }} {{ outcome }} {{ index }} {{ newest }} {{ new }}{{/each}}",
      }),
      options,
    ).status,
    "loaded",
  );
});

test("a placeholder must be a declared input or a step output", () => {
  const undeclared = withStep(2, { prompt: "{{ input.nope }}" });
  const message = has(undeclared, "steps[2].prompt");
  assert.match(message, /`\{\{ input\.nope \}\}` is neither a declared input nor a step output/);
  assert.match(message, /declared inputs: task\)/);
  const other = has(withStep(2, { prompt: "{{ test.nope }}" }), "steps[2].prompt");
  assert.doesNotMatch(other, /declared inputs/);
  const none = { ...withStep(2, { prompt: "{{input.x}}" }), inputs: undefined };
  assert.match(has(none, "steps[2].prompt"), /declared inputs: none\)/);
});

test("a placeholder in a promptFile is checked and located at the promptFile", () => {
  files["prompts/implement.md"] = "{{ input.nope }} and {{ input.task }}";
  try {
    assert.match(only(valid(), "steps[0].promptFile"), /input\.nope/);
  } finally {
    files["prompts/implement.md"] = "Do {{ input.task }}";
  }
});

test("every bad placeholder is reported", () => {
  const errors = errorsOf(withStep(2, { prompt: "{{ a.b }} {{ c.d }}" }));
  assert.equal(errors.length, 2);
});

test("text that is not a placeholder is left alone", () => {
  const manifest = withStep(2, { prompt: "{ not } { {input.nope} }" });
  assert.equal(loadWorkflow(manifest, options).status, "loaded");
});

test("all errors are reported together, not only the first", () => {
  const manifest = { ...valid(), name: "x", maxTransitions: 0 };
  assert.equal(errorsOf(manifest).length, 2);
});

test("one broken step does not cause false placeholder or reachability errors", () => {
  const manifest = {
    formatVersion: 1,
    steps: [
      { id: "a", kind: "command", run: "true", outputs: ["out"] },
      { id: "a", kind: "command", run: "true" },
      { id: "b", kind: "agent", harness: "claude", prompt: "{{ a.out }}", on: { ok: "$success" } },
    ],
  };
  assert.deepEqual(
    errorsOf(manifest).map((e) => e.path),
    ["steps[1].id"],
  );
  const broken = { formatVersion: 1, steps: [{ id: "a", kind: "x" }, manifest.steps[2]] };
  assert.deepEqual(
    errorsOf(broken).map((e) => e.path),
    ["steps[0].kind"],
  );
});

test("a count or duration message names the field once", () => {
  assert.equal(
    errorsOf(withStep(0, { timeout: "0s" }))[0]?.message,
    "timeout must be a positive duration with the unit s, m or h, such as 30m",
  );
});

test("args is a list of strings and defaults to []", () => {
  const args = ["--strict-mcp-config", "--max-budget-usd", "10"];
  const loaded = loadWorkflow(withStep(0, { args }), options);
  assert.equal(loaded.status, "loaded");
  if (loaded.status !== "loaded") return;
  assert.deepEqual((loaded.workflow.steps[0] as AgentStep).args, args);
  assert.deepEqual((loaded.workflow.steps[2] as AgentStep).args, []);
});

test("args that is not a list of strings names the step", () => {
  for (const args of [3, { a: "b" }, "--x", ["--x", 1]]) {
    assert.match(
      only(withStep(0, { args }), "steps[0].args"),
      /args of step implement must be a list/,
    );
  }
});

test("an owned flag in args is an error, in both forms", () => {
  for (const args of [["--model", "x"], ["--model=x"], ["--verbose"], ["-p"]]) {
    assert.match(
      only(withStep(0, { args }), "steps[0].args"),
      /args of step implement has .*, which the claude adapter sets/,
    );
  }
  assert.match(
    only(withStep(0, { args: ["--model=x"] }), "steps[0].args"),
    /use `model`, not `--model`/,
  );
  assert.match(only(withStep(0, { args: ["--effort", "low"] }), "steps[0].args"), /use `effort`/);
  assert.doesNotMatch(only(withStep(0, { args: ["-p"] }), "steps[0].args"), /use `/);
});

test("--settings and an owned flag of another harness are allowed in args", () => {
  assert.equal(loadWorkflow(withStep(0, { args: ["--settings", "{}"] }), options).status, "loaded");
  assert.equal(loadWorkflow(withStep(2, { args: ["--effort", "x"] }), options).status, "loaded");
});

test("args on a command step is an error", () => {
  assert.match(
    only(withStep(1, { args: [] }), "steps[1].args"),
    /not allowed on a step of kind command/,
  );
});
