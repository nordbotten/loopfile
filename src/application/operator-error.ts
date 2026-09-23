import type { WorkspaceMode } from "../domain/model.ts";

/** The closed failure vocabulary available to an operator. */
export type OperatorErrorCode =
  | "no_such_run"
  | "no_such_loop"
  | "log_unreadable"
  | "log_corrupt"
  | "bad_argument"
  | "no_terminal"
  | "owner_gone"
  | "owner_alive"
  | "workspace_dirty"
  | "leftover_processes"
  | "already_ended"
  | "workspace_missing"
  | "invalid_manifest"
  | "manifest_outdated"
  | "format_mismatch"
  | "git_missing"
  | "fetch_failed"
  | "untrusted"
  | "operation_failed";

export interface OperatorFailure {
  readonly summary: string;
  readonly code: OperatorErrorCode;
  readonly help: string;
}

export interface RenderedOperatorFailure {
  readonly stderr: string;
  readonly exitCode: 1 | 2;
}

/** Renders the launch confirmation with its selected workspace. */
export function renderLaunchConfirmation(
  runId: string,
  mode: WorkspaceMode,
  path: string,
  branch: string | undefined,
): string {
  return renderOperatorConfirmation({
    started: runId,
    workspace: `${mode} · ${path}`,
    ...(branch === undefined ? {} : { branch }),
  });
}

/** Renders an AXI confirmation block. */
export function renderOperatorConfirmation(fields: Readonly<Record<string, string>>): string {
  return `${Object.entries(fields)
    .map(([key, value]) => `${key}: ${renderValue(value)}`)
    .join("\n")}\n`;
}

/** Renders the operator failure block. Operator reads default to exit 2. */
export function renderOperatorFailure(
  failure: OperatorFailure,
  exitCode: 1 | 2 = 2,
): RenderedOperatorFailure {
  return renderOperatorFailureLines([failure.summary], failure.code, failure.help, exitCode);
}

/** Renders one error line for each problem in a failed operator command. */
export function renderOperatorFailureLines(
  summaries: readonly string[],
  code: OperatorErrorCode,
  help: string,
  exitCode: 1 | 2 = 2,
): RenderedOperatorFailure {
  return {
    stderr: `${summaries.map((summary) => `error: ${renderValue(summary)}`).join("\n")}\ncode: ${code}\nhelp: ${renderValue(help)}\n`,
    exitCode,
  };
}

function renderValue(value: string): string {
  if (!/[\n"]/.test(value) && value === value.trim()) return value;
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  return `"${escaped}"`;
}
