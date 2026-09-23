import type { RunCreated } from "../domain/events.ts";
import type { WorkspaceMode } from "../domain/model.ts";

export interface RunLocation {
  readonly targetFolder: string;
  readonly workspace: string;
  readonly workspaceMode: WorkspaceMode | "";
  readonly branch: string;
  readonly baseCommit: string;
}

export function runLocation(created: RunCreated | undefined): RunLocation {
  return {
    targetFolder: empty(created?.targetFolder),
    workspace: empty(created?.workspacePath),
    workspaceMode: empty(created?.workspaceMode),
    branch: empty(created?.branch),
    baseCommit: empty(created?.baseCommit),
  };
}

function empty<T extends string>(value: T | undefined): T | "" {
  return value ?? "";
}
