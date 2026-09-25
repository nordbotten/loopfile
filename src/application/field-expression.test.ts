import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateFieldExpression,
  type FieldExpression,
  parseFieldExpression,
} from "./field-expression.ts";

function filled(source: string, values: ReadonlyMap<string, string>): string | undefined {
  return evaluateFieldExpression(parseFieldExpression(source), values);
}

test("parses fixed text and a mix of text and data expressions", () => {
  const fixed = parseFieldExpression("opus");
  assert.deepEqual(fixed.reads, []);
  assert.equal(evaluateFieldExpression(fixed, new Map()), "opus");
  assert.equal(
    filled(`claude-\${triage.size}`, new Map([["triage.size", "large"]])),
    "claude-large",
  );
});

test("reads the full dotted name, including a hyphenated step ID", () => {
  assert.deepEqual(parseFieldExpression(`\${implement-easy.model}`).reads, [
    "implement-easy.model",
  ]);
});

test("evaluates expressions with JavaScript operators and string comparison", () => {
  assert.equal(filled(`\${"10" > "9"}`, new Map()), "false");
  assert.equal(filled(`\${input.model ?? "opus"}`, new Map()), "opus");
  assert.equal(filled(`\${input.model || "opus"}`, new Map([["input.model", ""]])), "opus");
  assert.equal(filled(`\${1 + 2 * 3}`, new Map()), "7");
  assert.equal(
    filled(`\${input.model ? input.model : "opus"}`, new Map([["input.model", "m"]])),
    "m",
  );
});

test("matches JavaScript behavior for every allowed operator", () => {
  const cases = [
    [`\${!""}`, "true"],
    [`\${"x" && "y"}`, "y"],
    [`\${"" && "fallback"}`, ""],
    [`\${"" || "fallback"}`, "fallback"],
    [`\${"x" || "fallback"}`, "x"],
    [`\${"" ?? "fallback"}`, ""],
    [`\${1 == "1"}`, "true"],
    [`\${true == 1}`, "true"],
    [`\${1 == true}`, "true"],
    [`\${input.missing == input.other}`, "true"],
    [`\${1 != "1"}`, "false"],
    [`\${1 === "1"}`, "false"],
    [`\${1 !== "1"}`, "true"],
    [`\${"10" < "9"}`, "true"],
    [`\${"10" <= "9"}`, "true"],
    [`\${"9" >= "10"}`, "true"],
    [`\${10 > 9}`, "true"],
    [`\${"a" + "b"}`, "ab"],
    [`\${1 + 2}`, "3"],
    [`\${6 * 7}`, "42"],
    [`\${7 / 2}`, "3.5"],
    [`\${7 % 2}`, "1"],
    [`\${"x" ? "yes" : "no"}`, "yes"],
    [`\${1 + (2 * 3)}`, "7"],
  ] as const;
  for (const [source, expected] of cases) assert.equal(filled(source, new Map()), expected, source);
});

test("keeps escaped interpolation as literal text", () => {
  assert.equal(filled(`\\\${input.model}`, new Map([["input.model", "value"]])), `\${input.model}`);
});

test("returns undefined when an expression reads an absent value", () => {
  const expression = parseFieldExpression(`\${triage.model}`);
  assert.equal(evaluateFieldExpression(expression, new Map()), undefined);
  assert.equal(evaluateFieldExpression(expression, new Map([["triage.model", ""]])), "");
});

test("rejects calls, computed access, this, arrays, objects and unsupported operators", () => {
  for (const source of [
    `\${input.model()}`,
    `\${input.model["x"]}`,
    `\${this.model}`,
    `\${[input.model]}`,
    `\${{model: input.model}}`,
    `\${input.model - 1}`,
    `\${-1}`,
    `\${null}`,
  ]) {
    assert.throws(() => parseFieldExpression(source), Error, source);
  }
});

test("rejects nullish and logical-or in one expression even when grouped", () => {
  assert.throws(() => parseFieldExpression(`\${input.model ?? (input.other || "opus")}`), Error);
});

test("rejects a backtick-wrapped value with the leave-out hint", () => {
  assert.throws(() => parseFieldExpression("`opus`"), /leave out the backticks/);
});

test("has a stable parsed expression shape", () => {
  const expression: FieldExpression = parseFieldExpression(`\${input.model}`);
  assert.deepEqual(expression.reads, ["input.model"]);
});
