# The v1 manifest

A Loopfile declares its workflow in `manifest.yaml`. This page is the whole of
what a v1 manifest can say. Field names are camelCase.

The loader builds the normalized model in [`src/domain/model.ts`](../src/domain/model.ts) from
the run's materialized Loopfile and fills in every default, so the runtime never
sees a missing value ([ADR 0002](adr/0002-normalized-runtime-model.md)). Every
check named below happens in the loader, before a model exists (#03). Unknown
fields are rejected everywhere, so new fields can arrive later with no format
version bump ([ADR 0006](adr/0006-format-versions.md)).

A name — a step ID, an outcome or an output — matches `^[a-z][a-z0-9_-]{0,63}$`.
A duration is a number plus `s`, `m` or `h`, such as `90s`, `30m`, `2h`. The
loader also rejects a duration of zero, which the shape alone allows.

## Top level

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `formatVersion` | yes | — | The integer `1`. A missing field fails to load. A higher value asks the user to upgrade Loopfile. A lower one goes to the upgrade prompt, not to a validation error. |
| `steps` | yes | — | An ordered list of at least one step. The first step is the entry step, and the list order is the fall-through path. |
| `inputs` | no | `{}` | A map from input name to a description or input definition. See [Inputs](#inputs). |
| `maxTransitions` | no | none | An integer of 1 or more. With no value a run has no transition limit. |
| `runTimeout` | no | none | A duration. It counts only run owner time, so the gap between a crash and a resume does not count. |
| `workspace` | no | `isolate` | The workspace mode. Only `isolate` is currently accepted. `--workspace <mode>` on launch or `loop` overrides this field. |

There is no `name`, `description` or `start` field in v1.

## Minimal example

This is the smallest useful manifest: an agent writes a file, reports an outcome,
and a command checks the file.

```yaml
formatVersion: 1
steps:
  - id: write
    kind: agent
    harness: claude
    prompt: |
      Create hello.txt with one line: hello. Then run `loopfile result done`.
    on:
      done: check
  - id: check
    kind: command
    run: grep -qx hello hello.txt
```

## Inputs

A manifest declares every input it takes, with a description of what it is (#103).
It can use the short form for required inputs and the long form when an input has
more to say:

```yaml
inputs:
  issue: the issue number to comment on
  merge:
    description: yes to merge the PR when CI is green, no to stop at a green PR
    default: "no"
```

An input name follows the name rule and is read under the data key `input.<name>`,
which every step can read. The step ID `input` is reserved.

- The short form `name: <description>` is required-input shorthand. The long
  form is a map with required `description` and optional `default`; both forms
  can appear in one manifest. Any other field in the map is a load error.
- A `default` must be text, so quote numbers, booleans and other YAML types.
  An empty string (`default: ""`) is valid. An input with a default is optional;
  one without a default is required.
- When launch leaves out an optional input, its default is stored as its value.
  Steps, prompts, `loopfile data get input.<name>` and `loopfile result` see no
  difference between a default and a value given with `--input`.
- A default is a value that someone wrote down, not an absent value. There is no
  "optional with no value" input, so a step always gets a value.
- A placeholder for an input the manifest does not declare is a load error that
  names the declared inputs.
- A declared input that no prompt uses is fine. A step can read it with
  `loopfile data get input.<name>`.
- An `--input` that is not declared is a launch error, and a required input with
  no `--input` or default is a launch error. Each problem input gets its own
  `error:` line, and a missing input's line shows its description. The `help:`
  line names optional inputs and their defaults. That message is the only place
  v1 shows the descriptions.

## Every step

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `id` | yes | — | Unique in the manifest. `input` is reserved for launch inputs. |
| `kind` | yes | — | `agent`, `command` or `ralph`. |
| `on` | agent and ralph | `{}` | A map from outcome to target. Its keys are the step's only allowed outcomes. |
| `onFailure` | no | `$failure` | Where a failed attempt goes. |
| `outputs` | no | none | The data keys the step must put. A list, or a map from name to outcomes. |
| `maxAttempts` | no | `5` | An integer of 1 or more. Every visit counts, including `onFailure` and cycles. |
| `timeout` | no | `1h` | A duration, per attempt. On a Ralph step it limits each iteration. |

## Agent and Ralph steps

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `harness` | yes | — | A name in the fixed harness adapter table: `claude` or `pi` ([ADR 0004](adr/0004-internal-harness-adapters-no-plugins.md)). There is no top-level default in v1. |
| `prompt` | one of the two | — | Inline prompt text. The loader writes it to a run-owned file and treats it as `promptFile`, so the model holds only paths. |
| `promptFile` | one of the two | — | A path relative to the manifest root that stays inside the Loopfile. An absolute path, or one that escapes, is a load error. In a thin `.loop` it is always a load error (#75). |
| `model` | no | harness default | A string passed to the harness unchanged. The loader does not check it. |
| `effort` | no | harness default | The harness's own word, checked against that harness's list. Claude: `low`, `medium`, `high`, `max`. PI: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `args` | no | `[]` | A list of strings. The adapter gives each one to the harness as one argument, unchanged: no shell, no templating, no `{{ ... }}` placeholders. The loader rejects an owned flag (see below). On a Ralph step every iteration gets the same `args`. |
| `maxIterations` | ralph only, no | `10` | An integer of 1 or more, per attempt. |

### Claude Code permissions

For `claude` Agent and Ralph steps, the adapter passes `--setting-sources
project,local`, so a user's `~/.claude/settings.json` cannot affect a step.
It keeps this adapter allowlist and sandbox wiring:

- `Bash(loopfile data *)`
- `Bash(loopfile result *)`
- access to the attempt scratch folder and run-owner socket, with `loopfile`
  outside the sandbox where required by the platform

The default permission mode is `auto`: allowlisted commands are always allowed,
and Claude's classifier decides other commands. To change the permissions from a
manifest, use `args`:

```yaml
args:
  - --settings
  - '{"permissions":{"allow":["Bash(git *)"]}}'
```

`--settings '<json>'` is merged into the adapter settings, so it can widen the
allowlist. `--permission-mode <mode>` changes the mode and wins over the
adapter's `auto` default. `--dangerously-skip-permissions` enables yolo mode;
use it only when the manifest is trusted because it removes the normal
permission checks. Yolo is never the default.

Exactly one of `prompt` and `promptFile` must be present. Both, or neither, is a
load error. A prompt is a [Handlebars](https://handlebarsjs.com/) template over prompt data,
which the run owner fills before each harness call (#96). It may use plain
placeholders and the `if`, `unless`, `each` and `with` blocks, with `else`,
`@first`, `@last`, `@index`, and `../` for an outer block level. A name is an
`input.<name>`, a `<step>.<output>`, `$history.<key>`, or a field of the current
`each` or `with` item. `$history.<key>` is allowed only for a declared input or
output. In an `each` over it, entries are oldest first and have `value`,
`attemptId`, `outcome`, `index` (from 1), `newest`, and `new`; `new` means put
since this step's prior attempt. `$history.input.<name>` has one entry with an
empty `attemptId` and `outcome`. `$run` has `runId`, `loopfileName`, `startedAt`,
`targetFolder`, `workspace`, `workspaceMode`, `branch`, `baseCommit`,
`transitions`, `maxTransitions`, and `runTimeout`; its two limits are `""` when
omitted. `$run.attempts` has every earlier attempt, oldest first, not the
running one. Each has `stepId`,
`attemptId`, `number` (the visit number for its step), `result`, `reason`,
`outcome`, `message`, `startedAt`, `index` (from 1), and `newest`. `$run.attempt` has `id`, `number`, `startedAt`,
`maxAttempts`, `timeout`, `lastAttempt`, `iteration`, `maxIterations`,
`lastIteration`, and `previousIteration`. `number` starts at 1 for each step
visit, and `lastAttempt` is true on its final allowed visit. `maxAttempts` and
`timeout` show only limits written in the manifest; either is `""` when omitted.
On an agent step, `iteration` and `maxIterations` are both `1`, `lastIteration`
is true, and `previousIteration` is `""`. On a Ralph step, `iteration` starts at
1 on every attempt, `maxIterations` is the step's limit, and `lastIteration` is
true only on the final iteration. `previousIteration` is `""` on iteration 1;
later it has the preceding iteration's `number` and its `reason`:
`no_outcome`, `timeout`, or `nonzero_exit`. `$run.previous` and a history
entry's `new` flag stay the same throughout an attempt. `$run.previous` is `""`
on the first step. Otherwise it follows the latest
`transition` into this step, with `stepId`, `attemptId`, `outcome`, `message`,
`reason`, and `data`. An outcome sets `outcome` and its message, leaving
`reason` empty; a timeout or `onFailure` route sets `reason`, leaving the other
two empty. `data.<step>.<output>` holds every declared output of the sending
step, as that attempt put it or `""`. Test a leaf such as
`$run.previous.data.test.log`, not a map: a map is true even when every value is
`""`. A list or map in a plain placeholder renders as stable, two-space-indented JSON.
`lookup`, `log`, partials, inline partials and decorators are load errors. Write `\{{` for literal `{{`. A map is true in `if`,
even when all its values are `""`. A prompt must end with `loopfile result <outcome>`.
The available step commands are:

- `loopfile result <outcome> [--message <text>]` reports the step outcome.
- `loopfile data get <key>` reads the newest value of a data key.
- `loopfile data put <key> <file|->` publishes a file or stdin as a data key.
- `loopfile data append <key> <value>` appends a value to a data key.

`args` is the only other harness setting in v1. `env` and tool lists do not
exist.

The command is the harness command, then `args` in order, then the flags the
adapter owns. The prompt is never an argument: the adapter sends it on stdin.
A step whose `args` holds an owned flag, as `--flag value` or `--flag=value`,
is a load error. It names the step and the flag. Owned flags:

- `claude`: `-p`, `--print`, `--output-format`, `--input-format`, `--verbose`,
  `--setting-sources`, `--model` (use `model`) and `--effort` (use `effort`).
  `--settings` is not owned. `claude` uses only the last `--settings`, so the
  adapter takes a `--settings '<json>'` out of `args` and merges it into its
  own `settings.json`. The value must be inline JSON that is a map. Maps merge,
  lists join, and the user's other values win.
- `pi`: `-p`, `--print`, `--mode`, `--no-session`, `--session`, `--session-id`,
  `--session-dir`, `--continue`, `-c`, `--resume`, `-r`, `--fork`,
  `--model` (use `model`) and `--thinking` (use `effort`). The session flags
  are owned so each attempt starts clean and writes no `pi` session.
  `--provider`, `--approve`, `--tools`, `--api-key` and other flags stay free
  for `args`.

`pi` uses the user's own `pi` login and default provider. The adapter sets no
provider, key or auth variable. Do not use `pi` with an Anthropic subscription
login: Anthropic does not allow third-party tools to use it. In `-p` mode `pi`
ignores untrusted project `.pi` files. To trust them, add `--approve` to `args`.

## Command steps

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `run` | yes | — | One string, run as `sh -e -c <run>`. Empty or whitespace-only is a load error. |

The working directory is always the workspace root, and the process inherits the
launch environment after any execution-context variables are removed, plus the
current `LOOPFILE_*` variables ([ADR 0005](adr/0005-execution-context-contract.md)).
A step may start another run; it is independent, and `cancel` on the outer run does not stop it.
For the operator `result` inside a step, use `env -u LOOPFILE_ENDPOINT loopfile result <runid>`.
v1 has no `env`, `shell`, `runFile` or `workingDirectory` field.

## Routing

Routes match outcomes only. An exit status never picks a route: it says clean
exit or failed attempt, nothing more. A step reports an outcome by running
`loopfile result <outcome>` (ADR 0005).

- A clean exit with an outcome that is a key of `on` goes to that target.
- A clean exit with no outcome goes to the next step in the list when the step
  has no `on`. When the step has `on`, the attempt fails. An agent step and a
  Ralph step always have `on`, so a clean exit alone is never approval.
- A failed attempt — a non-zero exit, a crash, a timeout, a missing required
  output, or an outcome that is not a key of `on` — takes `onFailure`. It never
  goes to the next step.
- A target is a step ID, `$success` or `$failure`. End state names cannot collide
  with step IDs, so no step ID is reserved for them.
- Going past the last step ends the run in success.
- `onFailure` routes count when the loader checks that the entry step can reach
  every step. An unreachable step is a load error.

There is no retry field. To retry a step, point `onFailure` at the step's own ID;
each retry is a new attempt.

## Outputs

An output is a data key `<stepId>.<name>` that only its own step can put. The
`outputs` field names the keys a step must put, using short names.

```yaml
outputs: [log]                       # required on every clean exit
outputs: { feedback: [changes_requested] }   # required only for these outcomes
```

Every outcome in the map form must be a key of `on`. A step with no `on` can use
only the list form. A missing output fails the attempt and takes `onFailure`;
only a put by this attempt counts, and a value from an earlier attempt does not.
A step may put keys under its own ID that `outputs` does not name, so leave out
a key that the step puts only sometimes. `key: []` in the map form does not
make a key optional: it requires the key on every clean exit. The model
normalizes both forms to a map, where an empty outcome list means every clean
exit. v1 has no output schema, and no step-level field limiting which keys a step
may read. The top-level `inputs` block is a different thing: it says what the
whole workflow takes at launch.

## Ralph steps

A Ralph step runs the same prompt in one harness call after another, each with
fresh context. Workspace changes and data puts survive between iterations.

- An iteration that reports an outcome and exits 0 ends the attempt with that
  outcome.
- An iteration that ends with no outcome means continue, so a fresh iteration
  starts.
- An iteration that times out, exits non-zero, or reports an outcome and then
  exits non-zero is stopped and counted, its outcome is ignored, and a fresh
  iteration starts. `timeout` is therefore a hard reset point.
- Hitting `maxIterations` with no outcome fails the attempt with the end reason
  `iteration_limit` and takes `onFailure`. It does not end the run.
- Outputs are checked once, at attempt end, for the reported outcome. A put by
  any iteration of the attempt counts.

## Limits

`maxAttempts` and `maxTransitions` end the run in failure with the reason
`attempt_limit` or `transition_limit` when they are hit. The runtime does not
start the attempt and does not take `onFailure`. `runTimeout` stops the current
attempt and ends the run with `run_timeout`. A step `timeout` is different: it
fails one attempt and takes `onFailure`. v1 has no `onExhausted` and no
`onTimeout` route.

`loopfile continue <runid> [-d]` continues an ended run other than a completed
or `internal_error` run. It reuses the run's Materialized Loopfile and workspace,
starts a new attempt of the stopped step without writing a transition, and
resets `maxAttempts`, `maxTransitions` and `runTimeout` counting from that
continue. Use `loopfile resume` for a crashed or `internal_error` run, and
`loopfile interrupt` to replace an attempt while the run is still running.
Loop child runs cannot be continued individually.

## Reference manifest

[`examples/implement-review/manifest.yaml`](../examples/implement-review/manifest.yaml)
is a full implement → test → review loop written against this page (#44). Its
[README](../examples/implement-review/README.md) explains each step.
