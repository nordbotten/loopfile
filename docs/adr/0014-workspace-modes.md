# Workspace modes

A single mode that runs every step in a Git worktree excludes folders that are not repositories and users who want changes made in place or in a clean folder. We chose three explicit workspace modes so a run can work in the launch folder, in an isolated copy, or with no Target files at all. `isolate` stays the default, preserving existing Loopfiles. This decision is part of nordbotten/loopfile#111 and the map at #14.

## Decisions

- **Target folder:** in `here`, the launch folder; in `isolate`, the Git top level when the launch folder is in a Git repository and Git is available, or the launch folder otherwise. `empty` has no Target folder.
- **`here`:** every step works in the launch folder itself. Loopfile does not inspect or modify Git in the Target folder, creates and removes no workspace, and makes no Run branch.
- **`isolate`:** every step works in `runs/<runid>/workspace`. When Git can make a worktree, Loopfile creates one from the Target folder's `HEAD` on `loopfile/<runid>`. Otherwise it makes a full copy of the Target folder. The same fallback covers a Target with no `.git`, no commits, or no `git` binary; these are not launch errors. A worktree starts at `HEAD`, without uncommitted changes.
- **`empty`:** every step works in a new empty folder at `runs/<runid>/workspace`. Nothing is copied from the Target folder, and the run has no Target path in its event or prompt facts. The step sees only its workspace path and normal attempt context.
- **Selection and default:** an optional top-level `workspace:` field in the Manifest selects `isolate`, `here` or `empty`. `--workspace <mode>` overrides it for a launch or a loop. The default is `isolate`, so a Loopfile with no new setting keeps its existing behavior.
- **Run record:** `run.created` records `workspacePath` and `workspaceMode` for every run. `here` and `isolate` also record `targetFolder`; `empty` omits it. An `isolate` run also records `isolateKind` as `worktree` or `copy`. Only an `isolate` worktree records `branch` and `baseCommit`; in other modes those fields and `isolateKind` are absent, not `null` or empty strings.
- **Format versions:** the `repositoryPath` to `targetFolder` rename does not bump the event format: event format `1` has not shipped, so no reader breaks. ADR 0006 gets no pre-1.0 carve-out. The optional top-level `workspace:` field is an addition to the manifest's allowed fields, so the manifest format version does not bump and stays at `1`.
- **Successful-run cleanup:** a successful run attempts to remove only an `isolate` worktree. If Git refuses, it stays and the reason is reported. An `isolate` copy and an `empty` folder stay; `here` never removes or cleans the user's folder. Failed, cancelled and crashed runs keep any workspace Loopfile made. Retained workspaces are removed only when asked through `remove` or `prune`; there is no timed cleanup.
- **Known difference:** an `isolate` copy brings gitignored files such as `.claude/settings.local.json`; a worktree does not bring them. This is documented, not fixed.
- **Concurrent `here` runs (#39):** Loopfile has no lock, so two `here` runs in one folder are allowed and will write to the same folder.

## Considered Options

- **Require Git for every mode:** simpler workspace creation, but excludes ordinary folders, fresh repositories with no commits, and machines without Git.
- **Always copy for `isolate`:** works without Git, but loses the Run branch and the cheaper worktree when Git can provide one. The ignored-files difference is accepted rather than making worktrees behave like copies.
- **Make `here` the default:** would write into a user's folder without an explicit choice and change what existing Loopfiles do. `isolate` preserves the current safe default.
- **Keep `repositoryPath`:** its name would be wrong when the Target is not a Git repository, so it becomes `targetFolder` before the event format ships.

## Consequences

- Git remains optional. The same `isolate` mode uses a worktree when possible and a full copy otherwise.
- A successful run keeps copy and empty-workspace output for inspection; users decide when to remove it with `remove` or `prune`.
- `here` is intentionally not serialized by a lock: concurrent runs may change the same files.
