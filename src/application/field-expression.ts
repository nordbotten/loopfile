import templatePlugin, { type TemplateLiteral } from "@jsep-plugin/template";
import jsep from "jsep";

jsep.plugins.register(templatePlugin);
jsep.addIdentifierChar("-");

/** The step fields that accept data expressions in this release. */
export const FIELD_EXPRESSION_FIELDS = ["model", "effort"] as const;

export class FieldExpressionError extends Error {}

export interface FieldExpression {
  readonly template: TemplateLiteral;
  /** Full data keys read by the template, in first-use order. */
  readonly reads: readonly string[];
}

const BINARY_OPERATORS = new Set([
  "&&",
  "||",
  "??",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "+",
  "*",
  "/",
  "%",
]);

type Value = string | number | boolean | undefined;

type BinaryEvaluator = (left: Value, right: Value) => Value;

const BINARY_EVALUATORS: Readonly<Record<string, BinaryEvaluator>> = {
  "+": add,
  "*": (left, right) => Number(left) * Number(right),
  "/": (left, right) => Number(left) / Number(right),
  "%": (left, right) => Number(left) % Number(right),
  "==": looseEqual,
  "!=": (left, right) => !looseEqual(left, right),
  "===": (left, right) => left === right,
  "!==": (left, right) => left !== right,
  "<": (left, right) => compare(left, right, "<"),
  ">": (left, right) => compare(left, right, ">"),
  "<=": (left, right) => compare(left, right, "<="),
  ">=": (left, right) => compare(left, right, ">="),
};

const COMPARATORS: Readonly<
  Record<string, (left: string | number, right: string | number) => boolean>
> = {
  "<": (left, right) => left < right,
  ">": (left, right) => left > right,
  "<=": (left, right) => left <= right,
  ">=": (left, right) => left >= right,
};

/** Parses field text as a JS template string without evaluating JavaScript. */
export function parseFieldExpression(text: string): FieldExpression {
  if (text.startsWith("`")) {
    throw new FieldExpressionError("leave out the backticks; field expressions add them");
  }

  let expression: jsep.Expression;
  try {
    expression = jsep(`\`${text}\``);
  } catch {
    throw new FieldExpressionError("field expression does not parse");
  }
  if (expression.type !== "TemplateLiteral") {
    throw new FieldExpressionError("field expression must be template text");
  }

  const template = expression as TemplateLiteral;
  const reads = new Set<string>();
  for (const part of template.expressions) {
    const operators = new Set<string>();
    inspect(part, reads, operators);
    if (operators.has("??") && operators.has("||")) {
      throw new FieldExpressionError("do not mix ?? and || in one expression");
    }
  }
  return { template, reads: [...reads] };
}

/** Evaluates only the parsed, allowlisted expression nodes against flat data keys. */
export function evaluateFieldExpression(
  field: FieldExpression,
  values: ReadonlyMap<string, string>,
): string | undefined {
  let result = field.template.quasis[0]?.value.cooked ?? "";
  for (const [index, expression] of field.template.expressions.entries()) {
    const value = evaluate(expression, values);
    if (value === undefined) return undefined;
    result += String(value);
    result += field.template.quasis[index + 1]?.value.cooked ?? "";
  }
  return result;
}

function inspect(expression: jsep.Expression, reads: Set<string>, operators: Set<string>): void {
  switch (expression.type) {
    case "Identifier":
      inspectIdentifier(expression as jsep.Identifier, reads);
      return;
    case "MemberExpression":
      inspectMember(expression, reads);
      return;
    case "Literal":
      inspectLiteral(expression as jsep.Literal);
      return;
    case "UnaryExpression":
      inspectUnary(expression as jsep.UnaryExpression, reads, operators);
      return;
    case "BinaryExpression":
      inspectBinary(expression as jsep.BinaryExpression, reads, operators);
      return;
    case "ConditionalExpression":
      inspectConditional(expression as jsep.ConditionalExpression, reads, operators);
      return;
    default:
      throw invalidExpression();
  }
}

function inspectIdentifier(expression: jsep.Identifier, reads: Set<string>): void {
  if (!isName(expression.name)) throw invalidExpression();
  reads.add(expression.name);
}

function isName(name: string): boolean {
  return name !== "this" && !name.startsWith("-");
}

function inspectMember(expression: jsep.Expression, reads: Set<string>): void {
  const name = staticName(expression);
  if (name === undefined) throw invalidExpression();
  reads.add(name);
}

function inspectLiteral(expression: jsep.Literal): void {
  const value = expression.value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw invalidExpression();
  }
}

function inspectUnary(
  expression: jsep.UnaryExpression,
  reads: Set<string>,
  operators: Set<string>,
): void {
  if (expression.operator !== "!" || !expression.prefix) throw invalidExpression();
  inspect(expression.argument, reads, operators);
}

function inspectBinary(
  expression: jsep.BinaryExpression,
  reads: Set<string>,
  operators: Set<string>,
): void {
  if (!BINARY_OPERATORS.has(expression.operator)) throw invalidExpression();
  operators.add(expression.operator);
  inspect(expression.left, reads, operators);
  inspect(expression.right, reads, operators);
}

function inspectConditional(
  expression: jsep.ConditionalExpression,
  reads: Set<string>,
  operators: Set<string>,
): void {
  inspect(expression.test, reads, operators);
  inspect(expression.consequent, reads, operators);
  inspect(expression.alternate, reads, operators);
}

function staticName(expression: jsep.Expression): string | undefined {
  if (expression.type === "Identifier") {
    const name = (expression as jsep.Identifier).name;
    return isName(name) ? name : undefined;
  }
  if (expression.type !== "MemberExpression") return undefined;
  const member = expression as jsep.MemberExpression;
  if (member.computed || member.property.type !== "Identifier") return undefined;
  const base = staticName(member.object);
  return base === undefined ? undefined : `${base}.${(member.property as jsep.Identifier).name}`;
}

function evaluate(expression: jsep.Expression, values: ReadonlyMap<string, string>): Value {
  switch (expression.type) {
    case "Identifier":
    case "MemberExpression": {
      const name = staticName(expression);
      return name === undefined ? undefined : values.get(name);
    }
    case "Literal":
      return (expression as jsep.Literal).value as string | number | boolean;
    case "UnaryExpression":
      return !evaluate((expression as jsep.UnaryExpression).argument, values);
    case "BinaryExpression":
      return evaluateBinary(expression as jsep.BinaryExpression, values);
    case "ConditionalExpression": {
      const conditional = expression as jsep.ConditionalExpression;
      return evaluate(conditional.test, values)
        ? evaluate(conditional.consequent, values)
        : evaluate(conditional.alternate, values);
    }
    default:
      throw invalidExpression();
  }
}

function evaluateBinary(
  expression: jsep.BinaryExpression,
  values: ReadonlyMap<string, string>,
): Value {
  const left = evaluate(expression.left, values);
  if (expression.operator === "&&") return left ? evaluate(expression.right, values) : left;
  if (expression.operator === "||") return left || evaluate(expression.right, values);
  if (expression.operator === "??") return left ?? evaluate(expression.right, values);
  const evaluateRight = BINARY_EVALUATORS[expression.operator];
  if (evaluateRight === undefined) throw invalidExpression();
  return evaluateRight(left, evaluate(expression.right, values));
}

function add(left: Value, right: Value): Value {
  return typeof left === "string" || typeof right === "string"
    ? String(left) + String(right)
    : Number(left) + Number(right);
}

function looseEqual(left: Value, right: Value): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (typeof left === typeof right) return left === right;
  if (typeof left === "boolean") return looseEqual(Number(left), right);
  if (typeof right === "boolean") return looseEqual(left, Number(right));
  return Number(left) === Number(right);
}

function compare(left: Value, right: Value, operator: string): boolean {
  const strings = typeof left === "string" && typeof right === "string";
  const a = strings ? left : Number(left);
  const b = strings ? right : Number(right);
  const compare = COMPARATORS[operator];
  if (compare === undefined) throw invalidExpression();
  return compare(a, b);
}

function invalidExpression(): FieldExpressionError {
  return new FieldExpressionError("field expression uses an unsupported JavaScript feature");
}
