import Handlebars from "handlebars/dist/cjs/handlebars.js";

/** One prompt data name, and the item scope that supplies its first field. */
export interface PromptRead {
  readonly name: string;
  readonly scope: readonly string[];
  readonly line: number;
  /** A block item may name a known map prefix instead of a full key. */
  readonly blockItem?: true;
}

export interface PromptCheckError {
  readonly line: number;
  readonly message: string;
}

export type PromptCheck =
  | { readonly status: "checked"; readonly reads: readonly PromptRead[] }
  | { readonly status: "invalid"; readonly errors: readonly PromptCheckError[] };

type Node = { readonly type?: unknown; readonly loc?: Location; readonly [key: string]: unknown };
type Location = { readonly start?: { readonly line?: unknown } };

type Contexts = readonly (readonly string[])[];
const BLOCKS = new Set(["if", "unless", "each", "with"]);
const DATA_NAMES = new Set(["first", "last", "index"]);
const REFUSED_HELPERS = new Map([
  ["lookup", "Handlebars lookup is not allowed"],
  ["log", "Handlebars log is not allowed"],
]);
const ALLOWED_STATEMENTS = new Set([
  "ContentStatement",
  "CommentStatement",
  "MustacheCommentStatement",
]);
const REFUSED_STATEMENTS = new Map([
  ["PartialStatement", "Handlebars partials are not allowed"],
  ["PartialBlockStatement", "Handlebars partials are not allowed"],
  ["DecoratorBlock", "Handlebars inline partials are not allowed"],
  ["Decorator", "Handlebars decorators are not allowed"],
]);
const RAW_TAGS = new Set(["/", "!", ">", "*"]);
export const EACH_ITEM_SCOPE = "$each";
export const HISTORY_ROOT = "$history";

/** Makes data-key segments literal so `this`, `else`, and friends remain data names. */
export function quotePromptNames(text: string): string {
  let quoted = "";
  let start = 0;
  for (;;) {
    const tag = nextTag(text, start);
    if (tag === undefined) return quoted + text.slice(start);
    quoted += text.slice(start, tag.open);
    quoted += tag.escaped
      ? text.slice(tag.open, tag.end)
      : `${tag.braces}${quoteTag(tag.text)}${tag.close}`;
    start = tag.end;
  }
}

interface Tag {
  readonly open: number;
  readonly end: number;
  readonly braces: "{{" | "{{{";
  readonly close: "}}" | "}}}";
  readonly text: string;
  readonly escaped: boolean;
}

function nextTag(text: string, start: number): Tag | undefined {
  const open = text.indexOf("{{", start);
  if (open === -1) return undefined;
  const braces = text[open + 2] === "{" ? "{{{" : "{{";
  const close = braces === "{{{" ? "}}}" : "}}";
  const finish = text.indexOf(close, open + braces.length);
  if (finish === -1) return undefined;
  const end = finish + close.length;
  return {
    open,
    end,
    braces,
    close,
    text: text.slice(open + braces.length, finish),
    escaped: text[open - 1] === "\\",
  };
}

/** Parses a prompt and finds every data name it reads, without rendering it. */
export function checkPrompt(text: string): PromptCheck {
  let tree: Node;
  try {
    tree = Handlebars.parse(quotePromptNames(text)) as Node;
  } catch (error) {
    return {
      status: "invalid",
      errors: [{ line: parseLine(error), message: "Handlebars prompt does not parse" }],
    };
  }
  const reads: PromptRead[] = [];
  const errors: PromptCheckError[] = [];
  checkProgram(tree, [[]], reads, errors);
  return errors.length === 0 ? { status: "checked", reads } : { status: "invalid", errors };
}

function checkProgram(
  node: Node,
  contexts: Contexts,
  reads: PromptRead[],
  errors: PromptCheckError[],
): void {
  for (const statement of nodes(node.body)) checkStatement(statement, contexts, reads, errors);
}

function checkStatement(
  statement: Node,
  contexts: Contexts,
  reads: PromptRead[],
  errors: PromptCheckError[],
): void {
  if (statement.type === "MustacheStatement") {
    checkMustache(statement, contexts, reads, errors);
    return;
  }
  if (statement.type === "BlockStatement") {
    checkBlock(statement, contexts, reads, errors);
    return;
  }
  const message = REFUSED_STATEMENTS.get(String(statement.type));
  if (message !== undefined) {
    error(statement, message, errors);
    return;
  }
  if (!ALLOWED_STATEMENTS.has(String(statement.type)))
    error(statement, "this Handlebars feature is not allowed", errors);
}

function checkMustache(
  node: Node,
  contexts: Contexts,
  reads: PromptRead[],
  errors: PromptCheckError[],
): void {
  const path = asNode(node.path);
  const name = pathName(path);
  const refusal = REFUSED_HELPERS.get(name);
  if (refusal !== undefined) {
    error(node, refusal, errors);
    return;
  }
  if (nodes(node.params).length !== 0 || node.hash !== undefined) {
    error(node, "Handlebars helpers are not allowed", errors);
    return;
  }
  read(path, contexts, reads, errors);
}

function checkBlock(
  node: Node,
  contexts: Contexts,
  reads: PromptRead[],
  errors: PromptCheckError[],
): void {
  const name = pathName(asNode(node.path));
  const refusal = REFUSED_HELPERS.get(name);
  if (refusal !== undefined) {
    error(node, refusal, errors);
    return;
  }
  if (!BLOCKS.has(name)) {
    error(node, "this Handlebars block is not allowed", errors);
    return;
  }
  const item = blockItem(node);
  if (item === undefined) {
    error(node, `Handlebars ${name} accepts one name`, errors);
    return;
  }
  const itemRead = read(item, contexts, reads, errors, true);
  const nested = blockContexts(name, contexts, itemRead);
  checkProgram(asNode(node.program), nested, reads, errors);
  // Handlebars renders an else branch at the same scope as the opening block.
  if (node.inverse !== undefined) checkProgram(asNode(node.inverse), contexts, reads, errors);
}

function blockItem(node: Node): Node | undefined {
  const params = nodes(node.params);
  const item = params[0];
  return params.length === 1 && item?.type === "PathExpression" && node.hash === undefined
    ? item
    : undefined;
}

function blockContexts(name: string, contexts: Contexts, item: PromptRead): Contexts {
  if (name === "with") return [...contexts, fullName(item)];
  if (name !== "each") return contexts;
  const scope = fullName(item);
  return [
    ...contexts,
    scope[0] === HISTORY_ROOT || scope[0] === "$run" ? scope : [EACH_ITEM_SCOPE],
  ];
}

function read(
  path: Node | undefined,
  contexts: Contexts,
  reads: PromptRead[],
  errors: PromptCheckError[],
  blockItem = false,
): PromptRead {
  const line = lineOf(path);
  const parts = strings(path?.parts);
  if (path?.data === true) {
    const name = parts.join(".");
    if (!DATA_NAMES.has(name)) error(path, `Handlebars @${name} is not allowed`, errors);
    const read = { name: `@${name}`, scope: contexts.at(-1) ?? [], line };
    reads.push(read);
    return read;
  }
  const depth = typeof path?.depth === "number" ? path.depth : 0;
  if (depth >= contexts.length) error(path, "this Handlebars outer level is not allowed", errors);
  const scope = contexts.at(Math.max(0, contexts.length - 1 - depth)) ?? [];
  const read = {
    name: parts.join("."),
    scope,
    line,
    ...(blockItem ? { blockItem: true as const } : {}),
  };
  reads.push(read);
  return read;
}

function fullName(read: PromptRead): readonly string[] {
  return read.name === "" ? read.scope : [...read.scope, ...read.name.split(".")];
}

function error(node: Node | undefined, message: string, errors: PromptCheckError[]): void {
  errors.push({ line: lineOf(node), message });
}

function lineOf(node: Node | undefined): number {
  return typeof node?.loc?.start?.line === "number" ? node.loc.start.line : 1;
}

function quoteTag(tag: string): string {
  const start = firstNonSpace(tag);
  if (start === -1) return tag;
  const end = firstSpaceAfter(tag, start);
  const head = tag.slice(start, end === -1 ? undefined : end);
  const tail = end === -1 ? "" : tag.slice(end);
  if (head[0] === "#") return quoteBlockTag(tag, start, head, tail);
  if (head === "else" || RAW_TAGS.has(head[0] ?? "")) return tag;
  return `${tag.slice(0, start)}${quoteName(head)}${tail}`;
}

function quoteBlockTag(tag: string, start: number, head: string, tail: string): string {
  return `${tag.slice(0, start + 1)}${head.slice(1)}${quoteArguments(tail)}`;
}

function quoteArguments(text: string): string {
  const first = firstNonSpace(text);
  if (first === -1) return text;
  const end = firstSpaceAfter(text, first);
  const name = text.slice(first, end === -1 ? undefined : end);
  return `${text.slice(0, first)}${quoteName(name)}${end === -1 ? "" : text.slice(end)}`;
}

function firstNonSpace(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== " " && text[index] !== "\t") return index;
  }
  return -1;
}

function firstSpaceAfter(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === " " || text[index] === "\t") return index;
  }
  return -1;
}

function quoteName(name: string): string {
  if (name === "this" || name.startsWith("@") || name.startsWith('"') || name.startsWith("'"))
    return name;
  let outer = "";
  while (name.startsWith("../")) {
    outer += "../";
    name = name.slice(3);
  }
  return `${outer}${name
    .split(".")
    .map((part) => `[${part}]`)
    .join(".")}`;
}

function parseLine(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  const marker = "on line ";
  const start = message.indexOf(marker);
  if (start === -1) return 1;
  const digits = message.slice(start + marker.length).split("\n", 1)[0] ?? "";
  const line = Number(digits.replaceAll(":", ""));
  return Number.isInteger(line) && line > 0 ? line : 1;
}

function asNode(value: unknown): Node {
  return typeof value === "object" && value !== null ? (value as Node) : {};
}

function nodes(value: unknown): readonly Node[] {
  return Array.isArray(value) ? value.map(asNode) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}

function pathName(path: Node): string {
  return path.data === true ? "" : strings(path.parts).join(".");
}
