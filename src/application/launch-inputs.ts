/**
 * The launch inputs of `loopfile <source> --input <name>=<value>` (#35).
 *
 * Pure: it reads the flag values and the manifest's declared inputs and says
 * what is wrong. Each value is text, never a file path, and goes to the data
 * key `input.<name>` before the first step starts.
 */

import { NAME_PATTERN } from "../domain/model.ts";

export type LaunchInputs = Readonly<Record<string, string>>;

export type InputsCheck =
  | { readonly ok: true; readonly inputs: LaunchInputs }
  | { readonly ok: false; readonly message: string };

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

/**
 * Every declared input is required and nothing else is accepted
 * (`docs/manifest-v1.md#inputs`). A missing input lists all of them, with
 * their descriptions.
 */
export function checkAgainstDeclared(
  given: LaunchInputs,
  declared: Readonly<Record<string, string>>,
): InputsCheck {
  const undeclared = Object.keys(given).filter((name) => !(name in declared));
  if (undeclared.length > 0) {
    const known = Object.keys(declared);
    return refuse(
      `--input ${undeclared.join(", ")} is not declared by the Loopfile. ` +
        (known.length === 0
          ? "The Loopfile takes no inputs."
          : `Declared inputs: ${known.join(", ")}.`),
    );
  }
  const missing = Object.keys(declared).filter((name) => !(name in given));
  if (missing.length > 0) {
    const lines = Object.entries(declared).map(([name, text]) => `  ${name}: ${text}`);
    return refuse(
      `missing --input for ${missing.join(", ")}. The Loopfile needs:\n${lines.join("\n")}`,
    );
  }
  return { ok: true, inputs: given };
}

function refuse(message: string): InputsCheck {
  return { ok: false, message };
}

/** Where a source is, what kind it is and what the run owner needs to start the run (#35, ADR 0008). */
export interface LaunchRequest {
  readonly source: string;
  readonly kind: "directory" | "thin" | "packed";
  /** The manifest itself when `source` is stdin (`-`). */
  readonly sourceText?: string;
  readonly repository: string;
  readonly inputs: LaunchInputs;
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
  if (!isRecord(value)) return undefined;
  const { source, sourceText, kind, repository, inputs } = value;
  if (typeof source !== "string" || typeof repository !== "string") return undefined;
  if (!isKind(kind) || !isInputs(inputs)) return undefined;
  if (!validSourceText(sourceText, kind)) return undefined;
  return { source, sourceText, kind, repository, inputs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSourceText(value: unknown, kind: LaunchRequest["kind"]): value is string | undefined {
  return value === undefined || (kind === "thin" && typeof value === "string");
}

function isKind(value: unknown): value is LaunchRequest["kind"] {
  return value === "directory" || value === "thin" || value === "packed";
}

function isInputs(value: unknown): value is LaunchInputs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((text) => typeof text === "string");
}
