import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPrompt } from "./prompt-check.ts";

test("checks every read with its current block scope", () => {
  assert.deepEqual(
    checkPrompt("{{ input.task }} {{#with review}}{{feedback}} {{../input.task}}{{/with}}"),
    {
      status: "checked",
      reads: [
        { name: "input.task", scope: [], line: 1 },
        { name: "review", scope: [], line: 1, blockItem: true },
        { name: "feedback", scope: ["review"], line: 1 },
        { name: "input.task", scope: [], line: 1 },
      ],
    },
  );
});

test("allows every documented block form and data name", () => {
  const checked = checkPrompt(
    "{{#unless input.task}}x{{/unless}}{{#each review}}{{@first}}{{@last}}{{@index}}{{../input.task}}{{/each}}",
  );
  assert.equal(checked.status, "checked");
});

test("rejects invalid blocks without skipping their valid branches", () => {
  for (const source of [
    "{{#lookup input.x}}{{/lookup}}",
    "{{#log input.x}}{{/log}}",
    "{{#unknown input.x}}{{/unknown}}",
    "{{#if input.x input.y}}{{/if}}",
    "{{#if input.x includeZero=true}}{{/if}}",
  ]) {
    assert.equal(checkPrompt(source).status, "invalid");
  }
  assert.equal(checkPrompt("{{#if input.x}}x{{else}}{{input.y}}{{/if}}").status, "checked");
});

test("rejects every Handlebars feature prompts do not allow", () => {
  for (const [source, feature] of [
    ["{{lookup input.x input.y}}", "lookup"],
    ["{{log input.x}}", "log"],
    ["{{> partial}}", "partials"],
    ['{{#*inline "partial"}}x{{/inline}}', "inline partials"],
    ["{{*decorator}}", "decorators"],
  ]) {
    const checked = checkPrompt(source ?? "");
    assert.equal(checked.status, "invalid");
    if (checked.status === "invalid") {
      assert.equal(checked.errors[0]?.line, 1);
      assert.match(checked.errors[0]?.message ?? "", new RegExp(`${feature ?? ""}.*not allowed`));
    }
  }
});

test("reports Handlebars parse errors at their prompt line", () => {
  const checked = checkPrompt("one\n{{#if input.task}}");
  assert.deepEqual(checked, {
    status: "invalid",
    errors: [{ line: 2, message: "Handlebars prompt does not parse" }],
  });
});
