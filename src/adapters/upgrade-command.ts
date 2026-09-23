/**
 * `loopfile upgrade <source>` and the foreground version check a launch runs
 * first (#65, ADR 0006, ADR 0002).
 *
 * File-backed inputs go through one path: read the manifest by input kind, plan
 * the upgrade (`planUpgrade`), validate the result, and rewrite the source in
 * place. The stdin filter validates and emits text instead of rewriting it. The
 * check asks first on a terminal; the command never asks. A rewrite writes
 * `<target>.upgrade.tmp` in the target's folder and renames it over the target,
 * so a failure never leaves half a manifest.
 */

import { chmod, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { LoadResult, LoopfileRoot } from "../application/load-workflow.ts";
import {
  type OperatorErrorCode,
  renderOperatorConfirmation,
  renderOperatorFailure,
} from "../application/operator-error.ts";
import {
  MANIFEST_UPGRADES,
  type ManifestUpgrades,
  parseUpgradeAnswer,
  planUpgrade,
  renderManifestDiff,
} from "../application/upgrade.ts";
import { FORMAT_VERSION } from "../domain/model.ts";
import {
  folderRoot,
  loadInput,
  loadManifest,
  MANIFEST_NAME,
  materializePacked,
} from "./directory-loader.ts";
import { askOnTerminal, classifyInput, InputError, type InputKind, readStdin } from "./input.ts";
import { writeArchive } from "./pack-command.ts";

export interface UpgradeIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** `process.stdin.isTTY && process.stdout.isTTY`. */
  readonly isTTY: boolean;
  /** Asks one question. `null` on EOF. */
  readonly ask: (question: string) => Promise<string | null>;
}

export type CheckResult = { readonly ok: true } | { readonly ok: false; readonly exitCode: number };

const USAGE = "Usage: loopfile upgrade <source>";
const HELP = `${USAGE}

Rewrite an outdated manifest to the current format version. The source may be
a directory, thin .loop or packed .loop, or '-' to read a thin manifest from stdin
and write it to stdout. Exit 0 means the source is current or was upgraded, 1 means the
manifest or operation failed, and 2 means the call was invalid.
`;
const FAILED: CheckResult = { ok: false, exitCode: 1 };

/** The `UpgradeIo` of a real terminal session. */
export function terminalUpgradeIo(
  out: (text: string) => void,
  err: (text: string) => void,
): UpgradeIo {
  return {
    out,
    err,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: askOnTerminal,
  };
}

/** The foreground check a launch calls before it starts a run. */
export async function checkManifestVersion(
  source: string,
  io: UpgradeIo,
  upgrades: ManifestUpgrades = MANIFEST_UPGRADES,
): Promise<CheckResult> {
  return guarded(
    source,
    (input) => checkInput(source, input, io, upgrades),
    (error) => {
      io.err(`loopfile: ${(error as Error).message}\n`);
      return FAILED;
    },
  );
}

/** Checks a manifest already read from stdin; stdin cannot be rewritten or queried again. */
export function checkManifestVersionText(
  source: string,
  text: string,
  io: UpgradeIo,
  upgrades: ManifestUpgrades = MANIFEST_UPGRADES,
): CheckResult {
  try {
    const plan = planUpgrade(text, upgrades);
    if (plan.kind === "not_older") return { ok: true };
    return outdated(source, io);
  } catch (error) {
    io.err(`loopfile: ${(error as Error).message}\n`);
    return FAILED;
  }
}

/** `loopfile upgrade <source>`. Returns the exit code. */
export async function upgradeCommand(
  argv: readonly string[],
  io: UpgradeIo,
  upgrades: ManifestUpgrades = MANIFEST_UPGRADES,
  readInput: () => Promise<Buffer> = readStdin,
): Promise<number> {
  if (argv.includes("--help")) {
    io.out(HELP);
    return 0;
  }
  const source = sourceOf(argv);
  if (source === undefined) {
    operatorFailure(io, "upgrade takes one source", "bad_argument", 2, USAGE);
    return 2;
  }
  if (source === "-")
    return upgradeStdin(io, upgrades, readInput).catch((error) =>
      resultExitCode(commandFailure(io)(error)),
    );

  const result = await guarded(
    source,
    (input) => commandInput(source, input, io, upgrades),
    commandFailure(io),
  );
  return result.ok ? 0 : result.exitCode;
}

function commandFailure(io: UpgradeIo): (error: unknown) => CheckResult {
  return (error) =>
    operatorFailure(
      io,
      error instanceof Error ? error.message : String(error),
      error instanceof InputError ? "bad_argument" : "operation_failed",
      error instanceof InputError ? 2 : 1,
    );
}

function sourceOf(argv: readonly string[]): string | undefined {
  try {
    const { positionals } = parseArgs({ args: argv.slice(1), options: {}, allowPositionals: true });
    return positionals.length === 1 ? positionals[0] : undefined;
  } catch {
    return undefined;
  }
}

/** A manifest read from a source. `folder` holds its files, when it has any. */
interface Input {
  readonly kind: InputKind;
  readonly text: string;
  readonly folder: string | undefined;
}

/** Reads the source, runs `act`, and removes any folder a packed source was extracted to. */
async function guarded(
  source: string,
  act: (input: Input) => Promise<CheckResult>,
  onError: (error: unknown) => CheckResult,
): Promise<CheckResult> {
  const scratch: { path?: string } = {};
  try {
    return await act(await readInput(source, scratch));
  } catch (error) {
    return onError(error);
  } finally {
    if (scratch.path !== undefined) await rm(scratch.path, { recursive: true, force: true });
  }
}

/** Reads the manifest. A packed source is extracted under `scratch.path`, which the caller removes. */
async function readInput(source: string, scratch: { path?: string }): Promise<Input> {
  const kind = await classifyInput(source);
  if (kind === "thin") return { kind, text: await readFile(source, "utf8"), folder: undefined };
  let folder = source;
  if (kind === "packed") {
    scratch.path = await mkdtemp(join(tmpdir(), "loopfile-upgrade-"));
    folder = join(scratch.path, "loopfile");
    await materializePacked(source, folder);
  }
  return { kind, text: await readFile(join(folder, MANIFEST_NAME), "utf8"), folder };
}

async function checkInput(
  source: string,
  input: Input,
  io: UpgradeIo,
  upgrades: ManifestUpgrades,
): Promise<CheckResult> {
  const plan = planUpgrade(input.text, upgrades);
  if (plan.kind === "not_older") return { ok: true };
  if (!io.isTTY) return outdated(source, io);
  const problem = validate(plan.text, input);
  if (problem !== undefined) return invalid(problem, io);
  io.out(renderManifestDiff(input.text, plan.text));
  if (!(await confirmed(io))) {
    io.err("Upgrade declined. Nothing changed.\n");
    return FAILED;
  }
  return rewriteAndReport(source, input, plan, io);
}

async function commandInput(
  source: string,
  input: Input,
  io: UpgradeIo,
  upgrades: ManifestUpgrades,
): Promise<CheckResult> {
  const plan = planUpgrade(input.text, upgrades);
  if (plan.kind === "not_older") return currentInput(source, input, io, true);
  const problem = validate(plan.text, input);
  if (problem !== undefined) return invalid(problem, io, true);
  return rewriteAndReport(source, input, plan, io, true);
}

/** Upgrades a thin manifest from stdin without writing or diffing it. */
async function upgradeStdin(
  io: UpgradeIo,
  upgrades: ManifestUpgrades,
  readInput: () => Promise<Buffer>,
): Promise<number> {
  let text: string;
  try {
    text = (await readInput()).toString("utf8");
  } catch (error) {
    return resultExitCode(
      operatorFailure(
        io,
        `cannot read stdin: ${(error as Error).message}`,
        "operation_failed",
        1,
        "Read the manifest from stdin.",
      ),
    );
  }

  const input: Input = { kind: "thin", text, folder: undefined };
  const plan = planUpgrade(text, upgrades);
  if (plan.kind === "not_older") {
    const problem = validateCurrentStdin(text);
    if (problem !== undefined) return resultExitCode(invalid(problem, io, true));
    io.out(text);
    io.err(
      renderOperatorConfirmation({
        upgraded: "-",
        from: String(FORMAT_VERSION),
        to: String(FORMAT_VERSION),
      }),
    );
    return 0;
  }

  const problem = validate(plan.text, input);
  if (problem !== undefined) return resultExitCode(invalid(problem, io, true));
  io.out(plan.text);
  io.err(
    renderOperatorConfirmation({
      upgraded: "-",
      from: String(plan.from),
      to: String(FORMAT_VERSION),
    }),
  );
  return 0;
}

function resultExitCode(result: CheckResult): number {
  return result.ok ? 0 : result.exitCode;
}

function validateCurrentStdin(text: string): string | undefined {
  try {
    return describe(loadManifest(text, "-", null));
  } catch (error) {
    return (error as Error).message;
  }
}

/** The normal load check on a source that is not older: any error is the loader's. */
async function currentInput(
  source: string,
  input: Input,
  io: UpgradeIo,
  operator = false,
): Promise<CheckResult> {
  const result = await loadInput(source, input.kind);
  const problem = describe(result);
  if (problem !== undefined) return invalid(problem, io, operator);
  if (operator) {
    io.err(
      renderOperatorConfirmation({
        upgraded: source,
        from: String(FORMAT_VERSION),
        to: String(FORMAT_VERSION),
      }),
    );
  } else {
    io.out(`Manifest is already at formatVersion ${FORMAT_VERSION}. Nothing changed.\n`);
  }
  return { ok: true };
}

function outdated(source: string, io: UpgradeIo): CheckResult {
  const help =
    source === "-" ? "loopfile upgrade - < old.yaml > new.yaml" : `loopfile upgrade ${source}`;
  return operatorFailure(io, "Manifest is outdated", "manifest_outdated", 2, help);
}

function invalid(problem: string, io: UpgradeIo, operator = false): CheckResult {
  if (operator)
    return operatorFailure(
      io,
      problem,
      "invalid_manifest",
      1,
      "Fix the manifest before upgrading.",
    );
  io.err(`${problem}\n`);
  return FAILED;
}

/** Why a load result is not a loaded workflow, or nothing when it is one. */
function describe(result: LoadResult): string | undefined {
  if (result.status === "loaded") return undefined;
  if (result.status === "older") return `formatVersion ${result.formatVersion} is older`;
  return result.errors
    .map((e) => `  ${e.path}${e.line === undefined ? "" : ` (line ${e.line})`}: ${e.message}`)
    .join("\n");
}

/** The problems with the upgraded text, using the same root a load of this input uses. */
function validate(text: string, input: Input): string | undefined {
  const root: LoopfileRoot | null = input.folder === undefined ? null : folderRoot(input.folder);
  const result = loadManifest(text, MANIFEST_NAME, root);
  const problem = describe(result);
  return problem === undefined ? undefined : `The upgraded manifest is not valid:\n${problem}`;
}

/** Asks until the answer is a yes or a no. */
async function confirmed(io: UpgradeIo): Promise<boolean> {
  for (;;) {
    const answer = parseUpgradeAnswer(await io.ask("Manifest is outdated. Upgrade? [Y/n] "));
    if (answer !== "again") return answer === "yes";
  }
}

async function rewriteAndReport(
  source: string,
  input: Input,
  plan: { readonly from: number; readonly text: string },
  io: UpgradeIo,
  operator = false,
): Promise<CheckResult> {
  await rewrite(source, input, plan.text);
  if (operator) {
    io.err(
      renderOperatorConfirmation({
        upgraded: source,
        from: String(plan.from),
        to: String(FORMAT_VERSION),
      }),
    );
  } else {
    io.out(`Upgraded ${source} from formatVersion ${plan.from} to ${FORMAT_VERSION}.\n`);
  }
  return { ok: true };
}

/** The one rewrite both commands use. Throws, with the target unchanged, on a failure. */
async function rewrite(source: string, input: Input, text: string): Promise<void> {
  if (input.kind === "directory") {
    await replaceAtomically(join(source, MANIFEST_NAME), (path) => writeFile(path, text));
    return;
  }
  const target = await realpath(source);
  if (input.kind === "thin") {
    await replaceAtomically(target, (path) => writeFile(path, text));
    return;
  }
  const folder = input.folder as string;
  await writeFile(join(folder, MANIFEST_NAME), text);
  await replaceAtomically(target, (path) => writeArchive(folder, path));
}

function operatorFailure(
  io: UpgradeIo,
  summary: string,
  code: OperatorErrorCode,
  exitCode: 1 | 2,
  help = "Check the command arguments.",
): CheckResult {
  io.err(renderOperatorFailure({ summary, code, help }, exitCode).stderr);
  return { ok: false, exitCode };
}

/** Writes `<target>.upgrade.tmp` with `produce`, keeps the target's mode, then renames it over. */
async function replaceAtomically(
  target: string,
  produce: (temporary: string) => Promise<void>,
): Promise<void> {
  const temporary = `${target}.upgrade.tmp`;
  try {
    const { mode } = await stat(target);
    await produce(temporary);
    await chmod(temporary, mode & 0o7777);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
