<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loopfile-logo-dark.svg">
    <img alt="Loopfile" src="docs/assets/loopfile-logo.svg" width="400">
  </picture>
</p>

# Loopfile

Agent workflows are easy to invent and hard to run.
Most of them live in bash scripts, tmux panes and hope.

Loopfile turns them into files you commit.

A loop is a `manifest.yaml`. Agents do the work, shell checks judge it, and
the result picks the next step. Loopfile runs the graph. No LLM decides
where the run goes.

- **Every run is isolated by default.** Its own Git branch. Your checkout
  stays clean.
- **Every run is recorded.** Each attempt goes into an event log. Follow it,
  inspect it, resume it.
- **Every run is bounded.** Attempts, timeouts and iteration limits come from
  the manifest, not from the agent's mood.
- **Built for agents.** Loopfile follows [AXI](https://axi.md/), the Agent
  eXperience Interface: `--json` data, fixed error codes, no prompts that
  wait for input, and a `help:` hint on each failure. An agent can start a
  loop, watch it and fix what broke.

Loopfile owns execution. You own the process.

Status: early. The format is versioned (`formatVersion: 1`), but expect changes
before 1.0.

## Install

Needs Node.js 24 or later. Git is needed only for Remote Loopfiles.

```sh
npm install -g loopfile
```

Agent steps need a harness CLI, for example `claude`, installed and logged in.

## Example

```yaml
# manifest.yaml
formatVersion: 1
steps:
  - id: write
    kind: agent
    harness: claude
    prompt: |
      Create a file named hello.txt in the workspace root. It holds one line: hello
      Commit the file. Then run: loopfile result done
    on:
      done: check
  - id: check
    kind: command
    run: |
      grep -qx hello hello.txt
      git ls-files --error-unmatch hello.txt > /dev/null
```

Run it from inside a Git repository:

```sh
loopfile path/to/loop-directory
loopfile status
git show loopfile/<runid>:hello.txt
```

Run `loopfile --help` for all commands.

## Platforms

Loopfile runs on Linux and macOS. On Windows, run it inside
[WSL](https://learn.microsoft.com/windows/wsl/). Native Windows is not supported.

## Documentation

The docs ship with the package:

```sh
loopfile docs            # list the topics
loopfile docs manifest   # print one topic
```

- `format` ([The Loopfile format](docs/loopfile-format.md)): source directory,
  `manifest.yaml`, thin and packed `.loop`, and upgrade.
- `manifest` ([The v1 manifest](docs/manifest-v1.md)): the fields of the
  manifest and the workflow model.
- `runtime` ([How a run works](docs/runtime.md)): steps, routing, attempts,
  limits, the execution context, step commands, handoffs, inputs and the
  workspace.
- `skill`: an agent skill for writing loops. Install it with:

  ```sh
  mkdir -p ~/.claude/skills/loopfile
  loopfile docs skill > ~/.claude/skills/loopfile/SKILL.md
  ```
- `patterns` ([Loop patterns](docs/loop-patterns.md)): patterns that keep a
  loop running unattended, such as fix budgets, flaky checks and shared locks.
- `skill`: an agent skill for writing loops. Install it with
  `loopfile docs skill > ~/.claude/skills/loopfile/SKILL.md`.

For remote sources and trust, see [Remote Loopfiles](docs/remote-loopfiles.md).

## License

MIT
