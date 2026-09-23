/**
 * The launch inputs of `loopfile <source> --input <name>=<value>` (#35).
 *
 * Pure: it reads the flag values and the manifest's declared inputs and says
 * what is wrong. Each value is text, never a file path, and goes to the data
 * key `input.<name>` before the first step starts.
 */

import { isRemoteRecord, type RemoteRecord } from "../domain/events.ts";
import { NAME_PATTERN, type WorkspaceMode } from "../domain/model.ts";

export type LaunchInputs = Readonly<Record<string, string>>;

export type InputsCheck =
  | { readonly ok: true; readonly inputs: LaunchInputs }
  | { readonly ok: false; readonly messages: readonly string[] };

export const INPUT_HELP = "Give each with --input <name>=<value>.";

/** Adds the defaults a failed launch can omit. */
export function inputHelp(defaults: Readonly<Record<string, string>> = {}): string {
  const optional = Object.entries(defaults)
    .map(([name, value]) => `${name} (default: ${value})`)
    .join(", ");
  return optional === "" ? INPUT_HELP : `${INPUT_HELP} Optional inputs: ${optional}`;
}

/** Parses one JSON Lines input set. */
export function parseInputSet(text: string): InputsCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse("input set is not valid JSON");
  }
  if (!isRecord(value)) return refuse("input set is not a JSON object");
  const problems = Object.entries(value)
    .filter(([, input]) => typeof input !== "string")
    .map(([name]) => `input "${name}" is not a string`);
  return problems.length === 0
    ? { ok: true, inputs: value as LaunchInputs }
    : { ok: false, messages: problems };
}

/** Joins fixed `--input` values with one source input set without overwriting. */
export function mergeInputSet(fixed: LaunchInputs, fromSource: LaunchInputs): InputsCheck {
  const duplicates = Object.keys(fixed).filter((name) => Object.hasOwn(fromSource, name));
  if (duplicates.length > 0) {
    return refuse(
      duplicates.map((name) => `input "${name}" is given by both --input and the input source`),
    );
  }
  return { ok: true, inputs: { ...fixed, ...fromSource } };
}

/** Turns each `--input` value, `name=value`, into a map. The value is everything after the first `=`. */
export function parseInputFlags(flags: readonly string[]): InputsCheck {
  const inputs = new Map<string, string>();
  for (const flag of flags) {
    const at = flag.indexOf("=");
    if (at < 0) return refuse(`--input ${flag} needs the form <name>=<value>`);
    const name = flag.slice(0, at);
    if (!NAME_PATTERN.test(name)) {
      return refuse(`--input name '${name}' must match ${NAME_PATTERN.source}`);
    }
    if (inputs.has(name)) return refuse(`--input ${name} is given more than once`);
    inputs.set(name, flag.slice(at + 1));
  }
  return { ok: true, inputs: Object.fromEntries(inputs) };
}

/** Rejects values whose names the manifest does not take, without requiring every input. */
export function checkDeclaredInputs(
  given: LaunchInputs,
  declared: Readonly<Record<string, string>>,
): InputsCheck {
  const undeclared = Object.keys(given).filter((name) => !Object.hasOwn(declared, name));
  return undeclared.length === 0
    ? { ok: true, inputs: given }
    : refuse(undeclaredMessages(undeclared, declared));
}

/** Resolves declared inputs and rejects names the manifest does not take. */
export function checkAgainstDeclared(
  given: LaunchInputs,
  declared: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>> = {},
): InputsCheck {
  const names = checkDeclaredInputs(given, declared);
  if (!names.ok) return names;
  const missing = missingInputNames(given, declared, defaults);
  if (missing.length > 0) return refuse(missingMessages(missing, declared));
  return { ok: true, inputs: resolvedInputs(given, declared, defaults) };
}

function undeclaredMessages(
  names: readonly string[],
  declared: Readonly<Record<string, string>>,
): readonly string[] {
  const known = Object.keys(declared);
  const declaration =
    known.length === 0 ? "The Loopfile takes no inputs." : `Declared inputs: ${known.join(", ")}.`;
  return names.map((name) => `--input ${name} is not declared by the Loopfile. ${declaration}`);
}

function missingInputNames(
  given: LaunchInputs,
  declared: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.keys(declared).filter(
    (name) => !Object.hasOwn(given, name) && !Object.hasOwn(defaults, name),
  );
}

function missingMessages(
  names: readonly string[],
  declared: Readonly<Record<string, string>>,
): readonly string[] {
  return names.map((name) => `missing --input ${name}: ${declared[name]}`);
}

function resolvedInputs(
  given: LaunchInputs,
  declared: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): LaunchInputs {
  if (Object.keys(defaults).length === 0) return given;
  const inputs: Record<string, string> = {};
  for (const name of Object.keys(declared)) {
    inputs[name] = Object.hasOwn(given, name) ? (given[name] ?? "") : (defaults[name] ?? "");
  }
  return inputs;
}

function refuse(message: string | readonly string[]): InputsCheck {
  return { ok: false, messages: typeof message === "string" ? [message] : message };
}

/** Where a source is, what kind it is and what the run owner needs to start the run (#35, ADR 0008). */
export interface LaunchRequest {
  readonly source: string;
  readonly kind: "directory" | "thin" | "packed";
  /** The manifest itself when `source` is stdin (`-`). */
  readonly sourceText?: string;
  readonly repository?: string;
  readonly inputs: LaunchInputs;
  /** Resolved mode for a launch, or the loop's CLI override for child runs. */
  readonly workspaceMode?: WorkspaceMode;
  /** Overrides the basename of the source in status and prompt facts. */
  readonly loopfileName?: string;
  readonly remote?: RemoteRecord;
  /** Set by an in-process loop owner, never by a CLI flag. */
  readonly loopId?: string;
  /** One-based position in the loop. */
  readonly loopIndex?: number;
}

/** The environment variable that hands a `LaunchRequest` to `loopfile __owner`, so no run file holds it. */
export const LAUNCH_ENV = "LOOPFILE_LAUNCH";

export function encodeLaunch(request: LaunchRequest): string {
  return JSON.stringify(request);
}

/** The request in `text`, or nothing when it is not one. */
export function decodeLaunch(text: string): LaunchRequest | undefined {
  try {
    return launchRequest(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function launchRequest(value: unknown): LaunchRequest | undefined {
  if (!isLaunchRequest(value)) return undefined;
  return {
    source: value.source,
    sourceText: value.sourceText,
    kind: value.kind,
    ...(value.repository === undefined ? {} : { repository: value.repository }),
    inputs: value.inputs,
    ...(value.workspaceMode === undefined ? {} : { workspaceMode: value.workspaceMode }),
    loopfileName: value.loopfileName,
    ...(value.remote === undefined ? {} : { remote: value.remote }),
    ...optionalLoopFields(value.loopId, value.loopIndex),
  };
}

function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (!isRecord(value)) return false;
  const { source, sourceText, kind, repository, inputs, workspaceMode } = value;
  return (
    typeof source === "string" &&
    (typeof repository === "string" || (workspaceMode === "empty" && repository === undefined)) &&
    isKind(kind) &&
    isInputs(inputs) &&
    validWorkspaceMode(workspaceMode) &&
    validSourceText(sourceText, kind) &&
    validLaunchMetadata(value)
  );
}

function validLaunchMetadata(value: Record<string, unknown>): boolean {
  return (
    validLoopfileName(value.loopfileName) &&
    (value.remote === undefined || isRemoteRecord(value.remote)) &&
    validLoopId(value.loopId) &&
    validLoopIndex(value.loopIndex)
  );
}

export function optionalLoopFields(
  loopId: string | undefined,
  loopIndex: number | undefined,
): Pick<LaunchRequest, "loopId" | "loopIndex"> {
  return {
    ...(loopId === undefined ? {} : { loopId }),
    ...(loopIndex === undefined ? {} : { loopIndex }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSourceText(value: unknown, kind: LaunchRequest["kind"]): value is string | undefined {
  return value === undefined || (kind === "thin" && typeof value === "string");
}

function validWorkspaceMode(value: unknown): boolean {
  return value === undefined || value === "isolate" || value === "here" || value === "empty";
}

function isKind(value: unknown): value is LaunchRequest["kind"] {
  return value === "directory" || value === "thin" || value === "packed";
}

function isInputs(value: unknown): value is LaunchInputs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((text) => typeof text === "string");
}

function validLoopfileName(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validLoopId(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validLoopIndex(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1)
  );
}
