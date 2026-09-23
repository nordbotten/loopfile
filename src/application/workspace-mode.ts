import type { WorkspaceMode } from "../domain/model.ts";

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "isolate";

export type WorkspaceModeSelection =
  | { readonly ok: true; readonly mode: WorkspaceMode }
  | { readonly ok: false; readonly message: string };

/** Selects a supported mode: CLI flag, Manifest field, then the safe default. */
export function selectWorkspaceMode(
  flag: string | undefined,
  manifest: WorkspaceMode | undefined,
): WorkspaceModeSelection {
  if (flag === undefined) return { ok: true, mode: manifest ?? DEFAULT_WORKSPACE_MODE };
  return flag === "isolate"
    ? { ok: true, mode: flag }
    : { ok: false, message: "--workspace must be one of: isolate" };
}
