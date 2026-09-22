import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepErrorCode } from "./step-commands.ts";
import {
  renderStep,
  requireEndpoint,
  routeStepCommand,
  STEP_COMMANDS,
  stepCommandHelp,
} from "./step-commands.ts";

const ENDPOINT = "/run/007/owner.sock";

test("a success is one `ok:` line plus its fields, and exits 0", () => {
  const rendered = renderStep({
    ok: true,
    summary: "read spec.full",
    fields: { bytes: "4182" },
  });
  assert.equal(rendered.stderr, "ok: read spec.full\nbytes: 4182\n");
  assert.equal(rendered.exitCode, 0);
});

test("a failure names the error, the code and what to try next", () => {
  const rendered = renderStep({
    ok: false,
    summary: 'no data key "spec.ful"',
    code: "unknown_key",
    help: [
      "Keys are set by earlier steps; check the step that puts it",
      "Run `loopfile data get <key>` with a key from your prompt",
    ],
  });
  assert.equal(
    rendered.stderr,
    'error: no data key "spec.ful"\n' +
      "code: unknown_key\n" +
      "help[2]:\n" +
      "  Keys are set by earlier steps; check the step that puts it\n" +
      "  Run `loopfile data get <key>` with a key from your prompt\n",
  );
});

test("outside an attempt every step command fails with the same blocked error", () => {
  const failure = requireEndpoint("data get", undefined);
  assert.ok(failure, "a missing endpoint is a failure");
  assert.equal(failure.code, "no_endpoint");
  assert.match(failure.summary, /data get/);
  assert.match(failure.summary, /attempt/);
  assert.ok(failure.help.length > 0, "a failure always says what to do next");
  for (const hint of failure.help) assert.ok(hint.trim().length > 0, "and no hint is blank");
  assert.equal(renderStep(failure).exitCode, 2);
});

test("an empty endpoint is no endpoint", () => {
  assert.ok(requireEndpoint("result", ""));
});

test("inside an attempt the step command runs", () => {
  assert.equal(requireEndpoint("result", ENDPOINT), undefined);
});

test("the step command group is the four commands a step calls", () => {
  assert.deepEqual(
    STEP_COMMANDS.map((command) => command.usage),
    [
      "result <outcome> [--message <text>]",
      "data get <key>",
      "data put <key> <file|->",
      "data append <key> <value>",
    ],
  );
  assert.deepEqual(
    STEP_COMMANDS.map((command) => command.name),
    ["result", "data", "data", "data"],
  );
});

test("a command that is not a step command is left to the operator table", () => {
  assert.equal(routeStepCommand(["launch", "review.loop"], ENDPOINT), undefined);
  assert.equal(routeStepCommand([], ENDPOINT), undefined);
});

test("a step command is answered on stderr, whatever its own arguments", () => {
  const blocked = routeStepCommand(["result", "approved", "--message", "hi"], undefined);
  assert.equal(blocked?.exitCode, 2);
  assert.match(blocked?.stderr ?? "", /code: no_endpoint/);

  const unbuilt = routeStepCommand(["result", "approved", "--message", "hi"], ENDPOINT);
  assert.equal(unbuilt?.exitCode, 2);
  assert.ok(unbuilt?.stderr.length, "a step command always says something on stderr");
});

test("outside an attempt there is no help block to print", () => {
  assert.equal(stepCommandHelp(undefined), "");
  assert.equal(stepCommandHelp(""), "");
});

test("the help block lists every step command against its summary", () => {
  assert.equal(
    stepCommandHelp(ENDPOINT),
    "\nStep commands (inside an attempt only):\n" +
      "  result <outcome> [--message <text>]  Report this step's outcome\n" +
      "  data get <key>                       Read a data key. Raw bytes on stdout\n" +
      "  data put <key> <file|->              Publish a data key from a file\n" +
      "  data append <key> <value>            Add a value to a data key's history\n",
  );
});

test("a field value stays one line: newlines, quotes and edge spaces are quoted", () => {
  const value = (raw: string) =>
    renderStep({ ok: true, summary: "x", fields: { message: raw } }).stderr.split("\n")[1];
  assert.equal(value("needs tests"), "message: needs tests");
  assert.equal(value("line one\nline two"), 'message: "line one\\nline two"');
  assert.equal(value('he said "no"'), 'message: "he said \\"no\\""');
  assert.equal(value(" indented"), 'message: " indented"');
  assert.equal(value("trailing "), 'message: "trailing "');
  assert.equal(value("a\\b\nc"), 'message: "a\\\\b\\nc"');
});

test("a failure the step can fix exits 1, one it cannot exits 2", () => {
  const fails = (code: StepErrorCode) =>
    renderStep({ ok: false, summary: "x", code, help: ["y"] }).exitCode;
  assert.equal(fails("unknown_key"), 1);
  assert.equal(fails("bad_outcome"), 1);
  assert.equal(fails("missing_arg"), 1);
  assert.equal(fails("stale_attempt"), 2);
  assert.equal(fails("no_endpoint"), 2);
});
