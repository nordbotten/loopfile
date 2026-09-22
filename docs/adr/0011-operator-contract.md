# An agent outside a run drives Loopfile through operator commands made for agents

An agent with no terminal and no person must be able to learn Loopfile, write a Loopfile, launch it, follow it, read the result, act on a failure and clean up. Before this, it had to write a scratch `.loop` and use `-d`, because the monitor fails with no terminal, and nothing told it how. We picked one contract for every operator command, the same shape the step side got in #83, so an agent learns one set of rules for the whole binary. The detail of each decision is in the ticket it cites. This ADR records what they are and how they fit.

## Decisions

- **Operator and step commands:** an operator command is called from outside a run. A step command is called by a running step (ADR 0005, #83). `loopfile result` is both: `LOOPFILE_ENDPOINT` set means the step form `result <outcome>`, unset means the operator form `result <runid>` (#195).
- **Output by kind (#190):** a structure command answers with a data structure and takes `--json`: `list`, `status`, `tail`, `check`, `result`. A payload command prints raw bytes and has no `--json`: `logs`, `docs`. A confirmation command prints an AXI `key: value` block on stderr: the launch path, `resume`, `cancel`, `pack`, `unpack`, `upgrade`, `remove`, `prune`. The launch path also prints the run ID on stdout. No environment variable and no terminal check turns agent output on.
- **Streams (#190):** the answer goes to stdout and the report and progress go to stderr, for every command in the binary.
- **Failures (#190, #196, #197, #200):** a failed operator command prints the AXI block `error:`, `code:`, `help:`. The operator side has its own closed code list, separate from the step side: `no_such_run`, `no_such_loop`, `log_unreadable`, `log_corrupt`, `bad_argument`, `no_terminal`, `owner_gone`, `owner_alive`, `workspace_dirty`, `leftover_processes`, `already_ended`, `workspace_missing`, `invalid_manifest`, `manifest_outdated`, `format_mismatch`, `git_missing`, `fetch_failed` and `operation_failed`. Each code is named by the ticket that needs it. `git_missing` and `fetch_failed` come from nordbotten/loopfile#10: a Remote Loopfile fetch fails with `git_missing` when there is no `git` on PATH, and with `fetch_failed` on any git exit 128, because a host gives the same error for "not found" and "no access".
- **Exit codes (#190, #196):** `0` the work succeeded, `1` it failed, `2` the call was wrong or the work could not start. A command that follows or collects a run reports the run: the launch path, `resume`, `tail`, `result`. A command that describes a run reports the read and never returns `1`: `status`, `list`, `logs`. A confirmation command reports its own work.
- **Terminal (#191):** only `status` with no run ID refuses without a terminal. Every other command works the same with or without one, except that the launch path and `resume` block silently until the run ends when they have no `-d`.
- **Launch and follow (#192):** the agent path is `loopfile <source> -d`, then `loopfile tail <runid> --json` (ADR 0010). The blocking launch stays for shell scripts. `tail` on a run that has ended prints its history and exits at once. There is no `--wait` flag, no `--json` on the launch path and no multiplexer: one `tail` per run.
- **Manifest from stdin (#193):** `loopfile -` and `loopfile check -` read a thin manifest from stdin, so an agent writes no scratch file. A manifest with assets still needs a directory. `loopfile check <source>` validates the manifest and the inputs, not the environment. `check` exiting `0` means launch will not refuse the Loopfile. A failed launch prints one `error:` line per problem.
- **Outdated manifest (#200):** a stdin manifest, and any source with no terminal, is refused with `manifest_outdated`. `loopfile upgrade -` is a filter from stdin to stdout. The rules are in ADR 0006.
- **Discovery (#194):** an agent learns Loopfile from the installed package, with no network: `loopfile --help` for the commands, `loopfile docs manifest` for the format, then `check -` to fix mistakes. `docs` and `examples` ship in the npm package. Every command has its own `--help`. `docs manifest` states that a prompt must end with `loopfile result <outcome>`. There is no JSON schema.
- **Agent skill (#199):** a thin `skills/loopfile/SKILL.md` ships in the npm package. It says when to use Loopfile and the order of the operator commands, and sends the agent to `docs manifest` for the format. It holds no format facts. `loopfile docs skill` prints it. A test checks that every command and flag it names exists.
- **Result (#195):** `loopfile result <runid>` reads what a run produced from `events.jsonl` and the run folder, with no run owner: the end reason, the last outcome, the run branch, the repository path and base commit, and the declared inputs and outputs. Values are inline up to 64 KiB, then a path. `result --json` is a versioned format (ADR 0006).
- **Failure and recovery (#196):** a Loopfile bug ends the run with `internal_error` instead of reading as a crash, and only that end reason can be resumed (ADR 0003). `logs <runid> --owner` prints `owner.log`. `cancel` is idempotent. Nobody force-ends a crashed run. An agent routes on the `tail` exit code, then on `endReason` or `code`, and needs no person on any branch.
- **Removal (#197):** `remove <runid>` and `prune` delete runs only when asked. They never delete the run branch. Only `remove --force` deletes uncommitted work (ADR 0003).
- **A run started from a step (#198):** allowed and not managed. It is a normal top-level run with no link to the outer run. `cancel`, `remove` and `prune` do not cascade. A step reaches the operator `result` with `env -u LOOPFILE_ENDPOINT`.

## The agent's path

1. `loopfile docs manifest`, then write the manifest.
2. `loopfile check - --json` until it prints `[]`.
3. `loopfile - -d --input <name>=<value>`, and read the run ID from stdout.
4. `loopfile tail <runid> --json` until it exits.
5. `loopfile result <runid> --json`.
6. On a failure, act on `endReason` or `code` (#196).
7. `loopfile remove <runid>`.

## Considered Options

- **One output mode for all commands, such as `--json` everywhere:** a JSON form of a one-line confirmation is code with no reader, and raw bytes from `logs` do not fit in JSON (#190).
- **Turn on agent output from the environment or when there is no terminal:** output that changes under a pipe breaks a person who pipes to `less` (#190).
- **Share the step code list:** no operator command can return a step code and no step command can return an operator code, so one list is a list nobody can branch on (#190).
- **A `--wait` flag or a blocking launch as the agent path:** the blocking launch gives silence for the whole run, and `-d` then `tail` already blocks without the terminal (#192).
- **A `--check` flag on the launch path:** a launch command that sometimes does not launch is easy to misuse (#193).
- **A full skill that copies the format:** a second copy of the docs that goes stale (#199).
- **Read the result through `data get`:** it needs a live run owner, which is gone when the run ends (#195).
- **A `recover` command:** it would read the same two files as `tail` and `result` and guess (#196).
- **Managed nesting of runs:** needs parent links, cascade and a depth cap in the run owner. It is a separate feature, #205 (#198).
