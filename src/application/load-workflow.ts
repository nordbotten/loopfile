/**
 * The loader's validation (#03, ADR 0002, ADR 0006).
 *
 * `loadWorkflow` takes a parsed manifest and either builds the normalized model
 * or returns every error it found. An invalid manifest never becomes a model,
 * and v1 has no warnings. Reading YAML and reading files is not done here: the
 * caller hands in the parsed value and a `LoopfileRoot` that reads prompt files.
 *
 * Each error names its place as a YAML path such as `steps[2].on.done`. The
 * parser that knows lines gives `locate`, which adds the line.
 */

import { HARNESSES, isHarnessName } from "../domain/harnesses.ts";
import {
  FORMAT_VERSION,
  type HarnessName,
  isEndState,
  type Millis,
  NAME_PATTERN,
  type Outcome,
  type OutputName,
  RESERVED_STEP_IDS,
  type Step,
  type StepId,
  type Target,
  type Workflow,
} from "../domain/model.ts";
import { durationMillis } from "./duration.ts";
import { checkPrompt, EACH_ITEM_SCOPE, HISTORY_ROOT, type PromptRead } from "./prompt-check.ts";

/** One thing wrong with a manifest, and where. */
export interface LoadError {
  /** The YAML path, such as `steps[2].on.done`. `""` is the manifest itself. */
  readonly path: string;
  /** The line in the manifest file, when the caller can find it. */
  readonly line?: number;
  readonly message: string;
}

/** The materialized Loopfile a manifest sits in. */
export interface LoopfileRoot {
  /** The text of a file, by path relative to the root. `undefined` when there is none. */
  readText(path: string): string | undefined;
}

export interface LoadOptions {
  /** `null` for a thin `.loop`, which has no files and so cannot use `promptFile`. */
  readonly root: LoopfileRoot | null;
  /** Finds the line of a YAML path. */
  readonly locate?: (path: string) => number | undefined;
}

export type LoadResult =
  | { readonly status: "loaded"; readonly workflow: Workflow }
  | { readonly status: "invalid"; readonly errors: readonly LoadError[] }
  /** An older format goes to the upgrade path (#65). It is not a validation error. */
  | { readonly status: "older"; readonly formatVersion: number };

/**
 * Where the loader says an inline prompt lives, relative to the materialized
 * Loopfile like every `promptFile`. It is in the run-owned `prompts/` folder
 * next to `loopfile/` (ADR 0002, #81). A manifest `promptFile` cannot leave
 * the Loopfile, so it can never name this path.
 */
export function inlinePromptFile(stepId: StepId): string {
  return `../prompts/${stepId}.md`;
}

const TOP_FIELDS = ["formatVersion", "steps", "inputs", "maxTransitions", "runTimeout"];
const COMMON_FIELDS = ["id", "kind", "on", "onFailure", "outputs", "maxAttempts", "timeout"];
const HARNESS_FIELDS = ["harness", "prompt", "promptFile", "model", "effort", "args"];
const KIND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  agent: HARNESS_FIELDS,
  ralph: [...HARNESS_FIELDS, "maxIterations"],
  command: ["run"],
};
const ALL_FIELDS = new Set([...COMMON_FIELDS, ...HARNESS_FIELDS, "maxIterations", "run"]);
/** The manifest field that replaces an owned flag, when there is one. */
const OWNED_FLAG_FIELDS = new Map([
  ["--model", "model"],
  ["--effort", "effort"],
]);
const HOUR_MS = 3_600_000;

type Raw = Readonly<Record<string, unknown>>;
type Report = (path: string, message: string) => void;

interface InputDeclarations {
  readonly descriptions: Record<string, string>;
  readonly defaults: Record<string, string>;
}

/** A prompt's text and the YAML path it came from. */
interface PromptText {
  /** The manifest field that names this prompt. */
  readonly path: string;
  /** The file a prompt author edits. */
  readonly file: string;
  readonly text: string;
}

interface Context {
  readonly report: Report;
  readonly root: LoopfileRoot | null;
  readonly stepIds: ReadonlySet<StepId>;
  readonly prompts: PromptText[];
}

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the model from a parsed manifest, or says what is wrong with it. */
export function loadWorkflow(manifest: unknown, options: LoadOptions): LoadResult {
  const errors: LoadError[] = [];
  const report: Report = (path, message) => {
    const line = options.locate?.(path);
    errors.push(line === undefined ? { path, message } : { path, line, message });
  };
  const invalid = (): LoadResult => ({ status: "invalid", errors });

  if (!isRecord(manifest)) {
    report("", "the manifest must be a map");
    return invalid();
  }
  const version = manifest.formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    report("formatVersion", "formatVersion is required and must be an integer");
    return invalid();
  }
  if (version > FORMAT_VERSION) {
    report(
      "formatVersion",
      `formatVersion ${version} is newer than this Loopfile knows (${FORMAT_VERSION}): upgrade loopfile`,
    );
    return invalid();
  }
  if (version < FORMAT_VERSION) return { status: "older", formatVersion: version };

  const workflow = buildWorkflow(manifest, options.root, report);
  return errors.length === 0 && workflow !== undefined ? { status: "loaded", workflow } : invalid();
}

function buildWorkflow(
  manifest: Raw,
  root: LoopfileRoot | null,
  report: Report,
): Workflow | undefined {
  for (const key of Object.keys(manifest)) {
    if (!TOP_FIELDS.includes(key)) report(key, `unknown field \`${key}\``);
  }
  const inputs = readInputs(manifest.inputs, report);
  const limits = readLimits(manifest, report);
  const rawSteps = manifest.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    report("steps", "steps must be a list of at least one step");
    return undefined;
  }
  const ctx: Context = { report, root, stepIds: collectStepIds(rawSteps, report), prompts: [] };
  const steps = rawSteps.map((raw, index) => readStep(raw, index, ctx));
  const built = steps.filter((step): step is Step => step !== undefined);
  // A step that did not build has no outputs and no targets, so checks that
  // read them would report errors that are not real.
  if (built.length !== steps.length || ctx.stepIds.size !== built.length) return undefined;
  checkPlaceholders(ctx.prompts, built, inputs.descriptions, report);
  checkReachable(built, report);
  return workflowModel(inputs, limits, built);
}

function workflowModel(
  inputs: InputDeclarations,
  limits: { maxTransitions?: number; runTimeoutMs?: Millis; declaredRunTimeout?: string },
  steps: readonly Step[],
): Workflow {
  return {
    formatVersion: FORMAT_VERSION,
    inputs: inputs.descriptions,
    ...optionalInputDefaults(inputs.defaults),
    ...limits,
    steps,
  };
}

function optionalInputDefaults(defaults: Readonly<Record<string, string>>): {
  readonly inputDefaults?: Readonly<Record<string, string>>;
} {
  return Object.keys(defaults).length === 0 ? {} : { inputDefaults: defaults };
}

/** The optional run limits. A limit the manifest leaves out is left out here too. */
function readLimits(
  manifest: Raw,
  report: Report,
): { maxTransitions?: number; runTimeoutMs?: Millis; declaredRunTimeout?: string } {
  const maxTransitions = optionalCount(manifest.maxTransitions, "maxTransitions", report);
  const runTimeoutMs = optionalDuration(manifest.runTimeout, "runTimeout", report);
  return {
    ...(maxTransitions === undefined ? {} : { maxTransitions }),
    ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
    ...(runTimeoutMs === undefined || typeof manifest.runTimeout !== "string"
      ? {}
      : { declaredRunTimeout: manifest.runTimeout }),
  };
}

function readInputs(raw: unknown, report: Report): InputDeclarations {
  const declarations: InputDeclarations = { descriptions: {}, defaults: {} };
  if (raw === undefined) return declarations;
  if (!isRecord(raw)) {
    report("inputs", "inputs must be a map from input name to a description or definition");
    return declarations;
  }
  for (const [name, value] of Object.entries(raw)) {
    const path = `inputs.${name}`;
    if (!NAME_PATTERN.test(name)) report(path, `input name \`${name}\` is not valid`);
    readInputDeclaration(name, value, path, declarations, report);
  }
  return declarations;
}

function readInputDeclaration(
  name: string,
  value: unknown,
  path: string,
  declarations: InputDeclarations,
  report: Report,
): void {
  if (typeof value === "string") {
    declarations.descriptions[name] = value;
    return;
  }
  if (!isRecord(value)) {
    report(path, "an input description must be a string");
    return;
  }
  readInputDefinition(name, value, path, declarations, report);
}

function readInputDefinition(
  name: string,
  value: Raw,
  path: string,
  declarations: InputDeclarations,
  report: Report,
): void {
  for (const key of Object.keys(value)) {
    if (key !== "description" && key !== "default") {
      report(`${path}.${key}`, `unknown field \`${key}\``);
    }
  }
  readInputDescription(name, value.description, path, declarations, report);
  readInputDefault(name, value, path, declarations, report);
}

function readInputDescription(
  name: string,
  value: unknown,
  path: string,
  declarations: InputDeclarations,
  report: Report,
): void {
  if (typeof value === "string") declarations.descriptions[name] = value;
  else report(`${path}.description`, "an input description is required and must be a string");
}

function readInputDefault(
  name: string,
  value: Raw,
  path: string,
  declarations: InputDeclarations,
  report: Report,
): void {
  if (!Object.hasOwn(value, "default")) return;
  if (typeof value.default === "string") declarations.defaults[name] = value.default;
  else report(`${path}.default`, "an input default must be text; quote it");
}

function collectStepIds(rawSteps: readonly unknown[], report: Report): Set<StepId> {
  const ids = new Set<StepId>();
  rawSteps.forEach((raw, index) => {
    const id = isRecord(raw) ? raw.id : undefined;
    const problem = stepIdProblem(id, ids);
    if (problem !== undefined) report(`steps[${index}].id`, problem);
    else ids.add(id as StepId);
  });
  return ids;
}

/** What is wrong with a step ID, given the IDs taken so far. `undefined` means nothing. */
function stepIdProblem(id: unknown, taken: ReadonlySet<StepId>): string | undefined {
  if (typeof id !== "string" || !NAME_PATTERN.test(id)) {
    return "a step id is required and must match ^[a-z][a-z0-9_-]{0,63}$";
  }
  if ((RESERVED_STEP_IDS as readonly string[]).includes(id)) {
    return `the step id \`${id}\` is reserved`;
  }
  return taken.has(id) ? `the step id \`${id}\` is used twice` : undefined;
}

/** The last part of a YAML path, for a message that already has the path in front. */
function fieldName(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function optionalCount(value: unknown, path: string, report: Report): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  report(path, `${fieldName(path)} must be an integer of 1 or more`);
  return undefined;
}

function optionalDuration(value: unknown, path: string, report: Report): Millis | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "string" ? durationMillis(value) : undefined;
  if (ms === undefined) {
    report(
      path,
      `${fieldName(path)} must be a positive duration with the unit s, m or h, such as 30m`,
    );
  }
  return ms;
}

function readStep(raw: unknown, index: number, ctx: Context): Step | undefined {
  const at = `steps[${index}]`;
  if (!isRecord(raw)) {
    ctx.report(at, "a step must be a map");
    return undefined;
  }
  const kind = raw.kind;
  if (kind !== "agent" && kind !== "command" && kind !== "ralph") {
    ctx.report(`${at}.kind`, "kind is required and must be agent, command or ralph");
    return undefined;
  }
  checkFields(raw, kind, at, ctx.report);
  return readKindStep(raw, kind, at, ctx);
}

/** A step of a known kind: the fields every step has, then the ones its kind adds. */
function readKindStep(
  raw: Raw,
  kind: "agent" | "command" | "ralph",
  at: string,
  ctx: Context,
): Step {
  const id = typeof raw.id === "string" ? raw.id : "";
  const base = readBase(raw, id, kind !== "command", at, ctx);
  if (kind === "command") return { ...base, kind, run: readRun(raw.run, at, ctx.report) };
  const harness = readHarnessFields(raw, id, at, ctx);
  if (kind === "agent") return { ...base, kind, ...harness };
  const maxIterations = optionalCount(raw.maxIterations, `${at}.maxIterations`, ctx.report) ?? 10;
  return { ...base, kind, ...harness, maxIterations };
}

function readBase(raw: Raw, id: StepId, needsOn: boolean, at: string, ctx: Context) {
  const on = readOn(raw.on, needsOn, at, ctx);
  const maxAttempts = optionalCount(raw.maxAttempts, `${at}.maxAttempts`, ctx.report);
  const timeoutMs = optionalDuration(raw.timeout, `${at}.timeout`, ctx.report);
  const declaredLimits = {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(timeoutMs === undefined || typeof raw.timeout !== "string" ? {} : { timeout: raw.timeout }),
  };
  return {
    id,
    on,
    onFailure: readOnFailure(raw.onFailure, at, ctx),
    outputs: readOutputs(raw.outputs, on, at, ctx.report),
    maxAttempts: maxAttempts ?? 5,
    timeoutMs: timeoutMs ?? HOUR_MS,
    ...(Object.keys(declaredLimits).length === 0 ? {} : { declaredLimits }),
  };
}

function checkFields(raw: Raw, kind: string, at: string, report: Report): void {
  const allowed = KIND_FIELDS[kind] as readonly string[];
  for (const key of Object.keys(raw)) {
    if (COMMON_FIELDS.includes(key) || allowed.includes(key)) continue;
    report(
      `${at}.${key}`,
      ALL_FIELDS.has(key)
        ? `\`${key}\` is not allowed on a step of kind ${kind}`
        : `unknown field \`${key}\``,
    );
  }
}

function readTarget(value: unknown, path: string, ctx: Context): Target {
  if (typeof value === "string" && (isEndState(value) || ctx.stepIds.has(value))) return value;
  ctx.report(path, "a target must be a step ID, $success or $failure");
  return "$failure";
}

function readOnFailure(value: unknown, at: string, ctx: Context): Target {
  return value === undefined ? "$failure" : readTarget(value, `${at}.onFailure`, ctx);
}

function readOn(
  value: unknown,
  required: boolean,
  at: string,
  ctx: Context,
): Record<Outcome, Target> {
  const on: Record<Outcome, Target> = {};
  if (value === undefined || (isRecord(value) && Object.keys(value).length === 0)) {
    if (required) {
      ctx.report(`${at}.on`, "an agent or ralph step needs `on` with at least one outcome");
    }
    return on;
  }
  if (!isRecord(value)) {
    ctx.report(`${at}.on`, "on must be a map from outcome to target");
    return on;
  }
  for (const [outcome, target] of Object.entries(value)) {
    if (!NAME_PATTERN.test(outcome)) {
      ctx.report(`${at}.on.${outcome}`, `outcome name \`${outcome}\` is not valid`);
    }
    on[outcome] = readTarget(target, `${at}.on.${outcome}`, ctx);
  }
  return on;
}

function readOutputs(
  value: unknown,
  on: Readonly<Record<Outcome, Target>>,
  at: string,
  report: Report,
): Record<OutputName, Outcome[]> {
  const outputs: Record<OutputName, Outcome[]> = {};
  const path = `${at}.outputs`;
  if (value === undefined) return outputs;
  if (Array.isArray(value)) {
    value.forEach((name, i) => {
      if (checkOutputName(name, `${path}[${i}]`, report)) outputs[name] = [];
    });
    return outputs;
  }
  if (isRecord(value)) return readOutputMap(value, on, path, report);
  report(path, "outputs must be a list of names or a map from name to outcomes");
  return outputs;
}

function readOutputMap(
  value: Raw,
  on: Readonly<Record<Outcome, Target>>,
  path: string,
  report: Report,
): Record<OutputName, Outcome[]> {
  if (Object.keys(on).length === 0) {
    report(path, "the map form of outputs needs a step with `on`; use a list");
  }
  const outputs: Record<OutputName, Outcome[]> = {};
  for (const [name, outcomes] of Object.entries(value)) {
    checkOutputName(name, `${path}.${name}`, report);
    outputs[name] = readOutputOutcomes(outcomes, on, `${path}.${name}`, report);
  }
  return outputs;
}

function checkOutputName(name: unknown, path: string, report: Report): name is string {
  if (typeof name === "string" && NAME_PATTERN.test(name)) return true;
  report(path, "an output name must match ^[a-z][a-z0-9_-]{0,63}$");
  return false;
}

function readOutputOutcomes(
  value: unknown,
  on: Readonly<Record<Outcome, Target>>,
  path: string,
  report: Report,
): Outcome[] {
  if (!Array.isArray(value)) {
    report(path, "an output must list the outcomes that require it");
    return [];
  }
  const outcomes: Outcome[] = [];
  for (const outcome of value) {
    if (typeof outcome === "string" && Object.hasOwn(on, outcome)) outcomes.push(outcome);
    else report(path, `\`${String(outcome)}\` is not a key of \`on\``);
  }
  return outcomes;
}

function readRun(value: unknown, at: string, report: Report): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  report(`${at}.run`, "a command step needs a `run` that is not empty");
  return "";
}

function readHarnessFields(raw: Raw, id: StepId, at: string, ctx: Context) {
  const harness = readHarness(raw.harness, at, ctx.report);
  const effort = readEffort(raw.effort, harness, at, ctx.report);
  const model = readOptionalString(raw.model, `${at}.model`, ctx.report);
  return {
    harness: harness ?? "claude",
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    args: readArgs(raw.args, harness, `${at}.args`, id, ctx.report),
    promptFile: readPrompt(raw, id, at, ctx),
  };
}

function readArgs(
  value: unknown,
  harness: HarnessName | undefined,
  path: string,
  id: StepId,
  report: Report,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string")) {
    report(path, `args of step ${id} must be a list of strings`);
    return [];
  }
  const args = value as string[];
  if (harness !== undefined) checkOwnedFlags(args, harness, path, id, report);
  return args;
}

function checkOwnedFlags(
  args: readonly string[],
  harness: HarnessName,
  path: string,
  id: StepId,
  report: Report,
): void {
  for (const arg of args) {
    const flag = arg.split("=", 1)[0] as string;
    if (!HARNESSES[harness].ownedFlags.includes(flag)) continue;
    const field = OWNED_FLAG_FIELDS.get(flag);
    const hint = field === undefined ? "" : `: use \`${field}\`, not \`${flag}\``;
    report(path, `args of step ${id} has ${flag}, which the ${harness} adapter sets${hint}`);
  }
}

function readHarness(value: unknown, at: string, report: Report): HarnessName | undefined {
  if (typeof value === "string" && isHarnessName(value)) return value;
  report(
    `${at}.harness`,
    `harness is required and must be one of: ${Object.keys(HARNESSES).join(", ")}`,
  );
  return undefined;
}

function readOptionalString(value: unknown, path: string, report: Report): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  report(path, `${path} must be a string`);
  return undefined;
}

function readEffort(
  value: unknown,
  harness: HarnessName | undefined,
  at: string,
  report: Report,
): string | undefined {
  if (value === undefined || harness === undefined) return undefined;
  const allowed = HARNESSES[harness].effort;
  if (typeof value === "string" && allowed.includes(value)) return value;
  report(`${at}.effort`, `effort for ${harness} must be one of: ${allowed.join(", ")}`);
  return undefined;
}

function readPrompt(raw: Raw, id: StepId, at: string, ctx: Context): string {
  const { prompt, promptFile } = raw;
  if ((prompt === undefined) === (promptFile === undefined)) {
    ctx.report(at, "give exactly one of `prompt` and `promptFile`");
    return "";
  }
  if (prompt === undefined) return readPromptFile(promptFile, `${at}.promptFile`, ctx);
  if (typeof prompt === "string" && prompt.trim() !== "") {
    ctx.prompts.push({ path: `${at}.prompt`, file: inlinePromptFile(id), text: prompt });
  } else {
    ctx.report(`${at}.prompt`, "prompt must be a string that is not empty");
  }
  return inlinePromptFile(id);
}

/** Resolves a relative path inside the root, or `undefined` when it leaves the root. */
function normalizeInside(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return undefined;
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

function readPromptFile(value: unknown, path: string, ctx: Context): string {
  if (typeof value !== "string" || value === "") {
    ctx.report(path, "promptFile must be a path");
    return "";
  }
  if (ctx.root === null) {
    ctx.report(
      path,
      "a thin .loop has no files, so it cannot use promptFile: use a source directory or a packed .loop",
    );
    return value;
  }
  if (/^([\\/]|[A-Za-z]:)/.test(value)) {
    ctx.report(path, "promptFile must be relative, not absolute");
    return value;
  }
  const inside = normalizeInside(value);
  if (inside === undefined) {
    ctx.report(path, "promptFile must stay inside the Loopfile");
    return value;
  }
  const text = ctx.root.readText(inside);
  if (text === undefined) ctx.report(path, `promptFile \`${value}\` is not in the Loopfile`);
  else ctx.prompts.push({ path, file: inside, text });
  return inside;
}

function checkPlaceholders(
  prompts: readonly PromptText[],
  steps: readonly Step[],
  inputs: Readonly<Record<string, string>>,
  report: Report,
): void {
  const known = promptKeys(steps, inputs);
  const declared = Object.keys(inputs).join(", ") || "none";
  for (const prompt of prompts) checkPromptText(prompt, known, declared, report);
}

function promptKeys(steps: readonly Step[], inputs: Readonly<Record<string, string>>): Set<string> {
  const known = new Set<string>(Object.keys(inputs).map((name) => `input.${name}`));
  for (const step of steps) {
    for (const name of Object.keys(step.outputs)) known.add(`${step.id}.${name}`);
  }
  return known;
}

function checkPromptText(
  prompt: PromptText,
  known: ReadonlySet<string>,
  declared: string,
  report: Report,
): void {
  const checked = checkPrompt(prompt.text);
  if (checked.status === "invalid") {
    for (const error of checked.errors)
      report(prompt.path, `${prompt.file}:${error.line}: ${error.message}`);
    return;
  }
  for (const read of checked.reads) reportUnknownPromptName(prompt, read, known, declared, report);
}

const HISTORY_FIELDS = new Set(["value", "attemptId", "outcome", "index", "newest", "new"]);
const RUN_ATTEMPT_FIELDS = new Set([
  "id",
  "number",
  "startedAt",
  "maxAttempts",
  "timeout",
  "lastAttempt",
  "iteration",
  "maxIterations",
  "lastIteration",
]);
const RUN_FIELDS = new Set([
  "runId",
  "loopfileName",
  "startedAt",
  "targetFolder",
  "branch",
  "baseCommit",
  "transitions",
  "maxTransitions",
  "runTimeout",
]);
const RUN_EARLIER_ATTEMPT_FIELDS = new Set([
  "stepId",
  "attemptId",
  "number",
  "result",
  "reason",
  "outcome",
  "message",
  "startedAt",
  "index",
  "newest",
]);
const RUN_PREVIOUS_ITERATION_FIELDS = new Set(["number", "reason"]);
const RUN_PREVIOUS_FIELDS = new Set(["stepId", "attemptId", "outcome", "message", "reason"]);

function reportUnknownPromptName(
  prompt: PromptText,
  read: PromptRead,
  known: ReadonlySet<string>,
  declared: string,
  report: Report,
): void {
  if (read.name === "" || read.name.startsWith("@")) return;
  if (isRunName(read, known)) return;
  const historyKey = historyKeyOf(read);
  if (historyKey !== undefined) {
    reportUnknownHistoryName(prompt, read, historyKey, known, declared, report);
    return;
  }
  reportUnknownDataName(prompt, read, known, declared, report);
}

function reportUnknownHistoryName(
  prompt: PromptText,
  read: PromptRead,
  key: string,
  known: ReadonlySet<string>,
  declared: string,
  report: Report,
): void {
  const field = read.scope[0] === HISTORY_ROOT ? read.name : undefined;
  if (known.has(key) && (field === undefined || HISTORY_FIELDS.has(field))) return;
  reportPromptName(
    prompt,
    read,
    `${HISTORY_ROOT}.${key}${field === undefined ? "" : `.${field}`}`,
    declared,
    report,
  );
}

function reportUnknownDataName(
  prompt: PromptText,
  read: PromptRead,
  known: ReadonlySet<string>,
  declared: string,
  report: Report,
): void {
  const key = [...read.scope, read.name].filter((part) => part !== "").join(".");
  const knownMap =
    read.blockItem === true && [...known].some((candidate) => candidate.startsWith(`${key}.`));
  if (known.has(key) || knownMap) return;
  reportPromptName(prompt, read, promptDisplayKey(read, key), declared, report);
}

function isRunName(read: PromptRead, known: ReadonlySet<string>): boolean {
  const name = promptName(read);
  if (name === "$run" || (name.startsWith("$run.") && RUN_FIELDS.has(name.slice("$run.".length))))
    return true;
  return isRunAttemptsName(name) || isRunAttemptName(name) || isRunPreviousName(read, known);
}

function isRunAttemptsName(name: string): boolean {
  if (name === "$run.attempts") return true;
  const field = name.slice("$run.attempts.".length);
  return name.startsWith("$run.attempts.") && RUN_EARLIER_ATTEMPT_FIELDS.has(field);
}

function isRunAttemptName(name: string): boolean {
  if (name === "$run.attempt" || name === "$run.attempt.previousIteration") return true;
  const field = name.slice("$run.attempt.".length);
  return (
    (name.startsWith("$run.attempt.") && RUN_ATTEMPT_FIELDS.has(field)) ||
    (name.startsWith("$run.attempt.previousIteration.") &&
      RUN_PREVIOUS_ITERATION_FIELDS.has(name.slice("$run.attempt.previousIteration.".length)))
  );
}

function isRunPreviousName(read: PromptRead, known: ReadonlySet<string>): boolean {
  const name = promptName(read);
  if (name === "$run.previous") return true;
  const parts = name.split(".");
  if (parts[0] !== "$run" || parts[1] !== "previous") return false;
  if (parts.length === 3) return RUN_PREVIOUS_FIELDS.has(parts[2] ?? "") || parts[2] === "data";
  if (parts[2] !== "data") return false;
  const key = parts.slice(3).join(".");
  return (
    known.has(key) ||
    (read.blockItem === true && [...known].some((candidate) => candidate.startsWith(`${key}.`)))
  );
}

function promptName(read: PromptRead): string {
  return [...read.scope, read.name].filter((part) => part !== "").join(".");
}

function historyKeyOf(read: PromptRead): string | undefined {
  if (read.scope[0] === HISTORY_ROOT) return read.scope.slice(1).join(".");
  return read.name.startsWith(`${HISTORY_ROOT}.`)
    ? read.name.slice(HISTORY_ROOT.length + 1)
    : undefined;
}

function reportPromptName(
  prompt: PromptText,
  read: PromptRead,
  displayKey: string,
  declared: string,
  report: Report,
): void {
  const hint = displayKey.startsWith("input.") ? ` (declared inputs: ${declared})` : "";
  report(
    prompt.path,
    `${prompt.file}:${read.line}: \`{{ ${displayKey} }}\` is neither a declared input nor a step output${hint}`,
  );
}

function promptDisplayKey(read: PromptRead, key: string): string {
  return read.scope.includes(EACH_ITEM_SCOPE) ? read.name : key;
}

/** The steps a step can move to: its routes, its `onFailure`, and the next step when it has no routes. */
function successors(
  steps: readonly Step[],
  index: number,
  byId: ReadonlyMap<string, number>,
): number[] {
  const step = steps[index] as Step;
  const routed = [...Object.values(step.on), step.onFailure].flatMap(
    (target) => byId.get(target) ?? [],
  );
  const fallsThrough = Object.keys(step.on).length === 0 && index + 1 < steps.length;
  return fallsThrough ? [...routed, index + 1] : routed;
}

function checkReachable(steps: readonly Step[], report: Report): void {
  const byId = new Map(steps.map((step, index) => [step.id, index]));
  const reached = new Set<number>();
  const queue = [0];
  for (let index = queue.pop(); index !== undefined; index = queue.pop()) {
    if (reached.has(index)) continue;
    reached.add(index);
    queue.push(...successors(steps, index, byId));
  }
  steps.forEach((step, index) => {
    if (!reached.has(index)) {
      report(`steps[${index}]`, `step \`${step.id}\` cannot be reached from the first step`);
    }
  });
}
