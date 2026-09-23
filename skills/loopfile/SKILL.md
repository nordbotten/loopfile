---
name: loopfile
description: Use Loopfile when you want an agent to run a deterministic software-engineering workflow and follow its result without a terminal.
---

# Loopfile

Use Loopfile to run a deterministic software-engineering workflow and follow it from outside the run.

## Operator flow

1. Read `loopfile docs manifest` for the manifest format. For a loop that runs
   unattended, also read `loopfile docs patterns`.
2. Write the manifest to standard input and run `loopfile check - --json` until it reports no problems.
3. Start it with `loopfile - -d`; take the run ID from stdout.
4. Follow the run with `loopfile tail <runid> --json` until it ends.
5. Read the result with `loopfile result <runid> --json`.
6. On failure, use `loopfile continue <runid> [-d]` to retry the stopped step of an ended, non-completed run; use `loopfile interrupt <runid>` to replace an active attempt, `loopfile resume <runid>` for a crashed or `internal_error` run, or `loopfile resume <loopid>` for a crashed loop.
7. Remove the run with `loopfile remove <runid>`. Continuing keeps the same run, branch and workspace.

When an agent launches a Remote Loopfile, pass `--trust` only if the user asked for that source.

## Claude Code step permissions

For Claude Code Agent and Ralph steps, the adapter loads only project and local
settings (`--setting-sources project,local`), never the operator's
`~/.claude/settings.json`. Its default mode is `auto`; these commands are always
allowed:

- `Bash(loopfile data *)`
- `Bash(loopfile result *)`

The adapter also wires the attempt scratch folder and run-owner socket. Claude's
classifier decides other commands. A manifest can use `args` to change that:

- `--settings '<json>'` is merged into the adapter settings and can widen the
  allowlist, for example `{"permissions":{"allow":["Bash(git *)"]}}`.
- `--permission-mode <mode>` changes the mode and overrides the `auto` default.
- `--dangerously-skip-permissions` enables yolo mode. Use it only for a trusted
  manifest; it removes the normal permission checks. Yolo is never the default.

Read `loopfile docs manifest` for the complete manifest rules.
