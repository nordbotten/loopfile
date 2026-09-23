# How a run works

This page is for Loopfile authors. It says what the runtime does with a
[manifest](manifest-v1.md) once a run starts. The manifest page lists every field.
The [format page](loopfile-format.md) covers the source directory, `.loop` files
and upgrade. This page does not repeat them. The terms are in
[`CONTEXT.md`](../CONTEXT.md).

Every example on this page loads with the real loader.

## Steps

`steps` is an ordered list. The first step is the entry step. A step `id` matches
`^[a-z][a-z0-9_-]{0,63}$`, is unique, and is never `input`.

There are three kinds of step:

| Kind | What it does | Own fields |
| --- | --- | --- |
| `agent` | Calls a harness once. | `harness`, `prompt` or `promptFile`, `model`, `effort`, `args` |
| `command` | Runs one shell command with `sh -e -c`, in the workspace root. | `run` |
| `ralph` | Calls a harness again and again, each time with fresh context. | Same as `agent`, plus `maxIterations` |

Every step also takes `on`, `onFailure`, `outputs`, `maxAttempts` and `timeout`.
`timeout` is a duration such as `90s`, `30m` or `2h`. It is per attempt and
defaults to `1h`. On a Ralph step it limits each iteration.

Exactly one of `prompt` and `promptFile` is set. `harness` is `claude` or `pi`.

```yaml source
formatVersion: 1
steps:
  - id: build
    kind: agent
    harness: claude
    model: sonnet
    effort: high
    prompt: Build the feature. Read the task with `loopfile data get input.task`.
    on:
      done: check
    timeout: 30m
  - id: check
    kind: command
    run: npm test
inputs:
  task: what to build
```

`build` is an agent step. `check` is a command step with no `on`, so a clean exit
goes to the next step. Going past the last step ends the run in success.

## Routing and outcomes

A step reports an outcome with `loopfile result <outcome>`. An outcome is not the
exit status. The exit status only says whether the process ended clean.

- A clean exit with an outcome that is a key of `on` goes to that target.
- A clean exit with no outcome goes to the next step in the list, when the step
  has no `on`. When the step has `on`, the attempt fails. An agent step and a
  Ralph step must have `on`, so a clean exit alone is never approval.
- A failed attempt goes to `onFailure`. It never falls through to the next step.
  The default for `onFailure` is `$failure`.

A target is a step ID, `$success` or `$failure`. `$success` ends the run in
success. `$failure` ends it in failure.

A failed attempt is any of these:

- a non-zero exit, or a process that could not start
- a timeout
- an outcome that is not a key of `on`
- a missing output (see [Handoffs and outputs](#handoffs-and-outputs))
- on a Ralph step, `iteration_limit` (see [Ralph steps](#ralph-steps))

An unreachable step is a load error. `onFailure` routes count as reachable.

```yaml source
formatVersion: 1
steps:
  - id: implement
    kind: agent
    harness: claude
    prompt: Implement the change. Report `done` when it is ready.
    on:
      done: review
  - id: review
    kind: agent
    harness: claude
    prompt: Review the change. Report `approved` or `changes_requested`.
    on:
      approved: $success
      changes_requested: implement
    onFailure: $failure
```

## Attempts

An attempt is one execution of a step. Every visit to a step is a new attempt,
also after `onFailure` or around a cycle.

`maxAttempts` is an integer of 1 or more and defaults to `5`. It counts every
visit to the step in the run. When a step would start attempt `maxAttempts + 1`,
the runtime does not start it. It ends the run in failure with the end reason
`attempt_limit` and does not take `onFailure`.

There is no retry field. To retry, point `onFailure` at the step's own ID:

```yaml source
formatVersion: 1
steps:
  - id: flaky
    kind: command
    run: ./ci/flaky-check.sh
    onFailure: flaky
    maxAttempts: 3
```

This step runs up to 3 times. If the third attempt fails, the run ends with
`attempt_limit`.

## Run limits

Two optional limits apply to the whole run. Neither has a default.

| Field | Meaning | End reason |
| --- | --- | --- |
| `maxTransitions` | An integer of 1 or more. The most moves between steps or to an end state. | `transition_limit` |
| `runTimeout` | A duration. It counts only run owner time, so a gap between a crash and a resume does not count. | `run_timeout` |

With no value, the run has no such limit. Both end the run in failure, together
with `attempt_limit`. `run_timeout` stops the attempt that is running. A step
`timeout` is different: it fails one attempt and takes `onFailure`.

```yaml source
formatVersion: 1
maxTransitions: 40
runTimeout: 2h
steps:
  - id: work
    kind: command
    run: make build
```

A run has five end reasons: `end_state` (it reached `$success`, `$failure` or the
end of the list), `attempt_limit`, `transition_limit`, `run_timeout` and
`internal_error` (a bug escaped the run owner). `iteration_limit` is not a run
end reason. It ends one Ralph attempt.

## Ralph steps

A Ralph step calls the same prompt in one harness call after another. Each call is
an iteration and starts with fresh context. Changes in the workspace and data
puts stay between iterations.

- An iteration that reports an outcome and exits 0 ends the attempt with that
  outcome.
- An iteration that ends with no outcome means continue. A new iteration starts.
- An iteration that times out, exits non-zero, or reports an outcome and then
  exits non-zero is stopped and counted. Its outcome is ignored and a new
  iteration starts.
- `timeout` limits each iteration.
- `maxIterations` is an integer of 1 or more, per attempt, and defaults to `10`.
  When it is reached with no outcome, the attempt fails with `iteration_limit`
  and takes `onFailure`. It does not end the run.
- Outputs are checked once, at the end of the attempt. A put by any iteration
  counts.

```yaml source
formatVersion: 1
steps:
  - id: grind
    kind: ralph
    harness: claude
    prompt: Fix the next failing test. Report `all_green` when none fail.
    maxIterations: 20
    timeout: 20m
    on:
      all_green: $success
    onFailure: $failure
```

## Execution context

Every attempt of every step kind gets the same execution context
([ADR 0005](adr/0005-execution-context-contract.md)). It is a set of variables
in the step's process. The working directory of a step is the workspace root.

| Variable | Value |
| --- | --- |
| `LOOPFILE_RUN_ID` | The run ID. |
| `LOOPFILE_ATTEMPT_ID` | The attempt ID, such as `007-fix`. |
| `LOOPFILE_STEP` | The step ID. |
| `LOOPFILE_PROTOCOL_VERSION` | The integer version of this contract. |
| `LOOPFILE_WORKSPACE` | The workspace root. |
| `LOOPFILE_SCRATCH` | A writable folder for temp files that must not be committed. Nothing in it is collected. |
| `LOOPFILE_ENDPOINT` | An opaque value that the step commands use to reach the run owner. |
| `LOOPFILE_ATTEMPT_SECRET` | A random value made for each attempt. A Ralph step gets a new one for each iteration. |
| `LOOPFILE_ITERATION` | The iteration number, from 1. Set on a Ralph step only. |

A step gets no path to the materialized Loopfile or to the run's storage. It
reads and writes handoffs only through the step commands. The run owner accepts a
call only from the attempt, and for a Ralph step the iteration, that is running
now.

A command step also inherits the variables of the process that launched the run.

## Step commands

A step command is a `loopfile` command that a running step calls. It works only
inside an attempt, where `LOOPFILE_ENDPOINT` is set. Anywhere else it fails with
the code `no_endpoint`.

| Command | What it does |
| --- | --- |
| `loopfile result <outcome> [--message <text>]` | Reports the outcome of the step. The outcome must be a key of `on`. A step reports one outcome per attempt, and a Ralph step one per iteration. A `--message` is for the log only. It is cut to 500 bytes. No step and no prompt can read it, so put text that a later step needs with `data put`. |
| `loopfile data get <key>` | Prints the newest value of the key on stdout. |
| `loopfile data put <key> <file\|->` | Publishes the content of a file, or of stdin with `-`, under the key. |
| `loopfile data append <key> <value>` | Adds a value to the key's history. |

Output is agent-first. Stdout carries only the payload bytes of `data get`, so
`loopfile data get build.log > build.log` needs no flag. A report goes to stderr
as `key: value` lines, one fact per line:

```
ok: read build.log
attempt: 003-build
bytes: 1204
```

A failure prints `error:`, a `code:` and a `help` list. The exit code is 1 when
the step can fix the call (`unknown_key`, `bad_outcome`, `missing_arg`,
`invalid_key`, `write_kind_mismatch`). It is 2 for a problem of the run
(`stale_attempt`, `no_endpoint`).

`data get` prints the ID of the attempt that put the value, so a step can tell a
fresh value from an old one. A key with no value is `unknown_key`.

`data put` and `data append` share a key rule. A key can be written with one of
them only. Mixing them is `write_kind_mismatch`. A `put` replaces the newest
value. An appended key keeps its whole history in the event log.

A command step calls the same commands from its shell:

```yaml source
formatVersion: 1
steps:
  - id: measure
    kind: command
    run: |
      wc -l README.md > "$LOOPFILE_SCRATCH/lines.txt"
      loopfile data put measure.lines "$LOOPFILE_SCRATCH/lines.txt"
      loopfile result counted
    outputs: [lines]
    on:
      counted: $success
```

## Handoffs and outputs

A handoff is data that one step puts for a later step to read. A data key is
`<stepId>.<name>`, and only its own step can put it. A step reads any key with
`loopfile data get`.

`outputs` lists the keys a step must put before its attempt ends. It has two
forms:

```yaml source
formatVersion: 1
steps:
  - id: write
    kind: agent
    harness: claude
    prompt: Write the spec and put it with `loopfile data put write.spec spec.md`.
    outputs: [spec]
    on:
      done: review
  - id: review
    kind: agent
    harness: claude
    prompt: |
      Read the spec with `loopfile data get write.spec`.

      Put your notes in `review.feedback` when you ask for changes, and in
      `review.notes` when you approve.
    outputs:
      feedback: [changes_requested]
      notes: [approved]
    on:
      approved: publish
      changes_requested: write
  - id: publish
    kind: command
    run: |
      loopfile data get review.notes >> "$LOOPFILE_SCRATCH/notes.md"
      loopfile result done
    on:
      done: $success
```

- The list form `outputs: [spec]` requires each key on every clean exit.
- The map form `outputs: { feedback: [changes_requested] }` requires a key only
  for the listed outcomes. Each one must be a key of `on`.

A missing output fails the attempt and takes `onFailure`. Only a put by this
attempt counts. A value from an earlier attempt does not.

A step that sends text out of the run, for example into a pull request, reads it
with `data get` like any other step. The review above must put `review.notes` when it
approves, so `publish` always has a value to read.

A prompt is a [Handlebars](https://handlebarsjs.com/) template. The loader parses it
and checks every name before a run starts; the run owner fills it before each
harness call. Plain placeholders, `if`, `unless`, `each` and `with` blocks,
`else`, `@first`, `@last`, `@index`, and `../` for an outer block level are
allowed. A name is an `input.<name>`, a `<step>.<output>`, `$history.<key>`, or
a field of the current `each` or `with` item. `$history.<key>` is allowed only
for a declared input or output. Its entries are oldest first; `value`,
`attemptId`, `outcome`, `index`, `newest`, and `new` are always set. `new` marks
a value put since the step's prior attempt. The prior attempt is the reading
step's own, so when several steps read the same history, for example one fix
step for each cause, `new` also marks values that another step has already
handled. Test `$run.previous.data.<step>.<output>` to find the value that sent
the run here, and `newest` to find it in the history. `$history.input.<name>` has one entry
with empty `attemptId` and `outcome`. `$run` gives `runId`, `loopfileName`,
`startedAt`, `targetFolder`, `workspace`, `workspaceMode`, `branch`, `baseCommit`,
`transitions`, `maxTransitions`, and
`runTimeout`; its two limits are `""` when omitted.
`$run.attempts` lists every earlier attempt, oldest first, without the running
one. Its entries have `stepId`, `attemptId`, `number` (the visit number for its
step), `result`, `reason`, `outcome`, `message`, `startedAt`, `index` (from 1),
and `newest`. `$run.attempt` gives the current visit's `id`, `number`, `startedAt`, `maxAttempts`, `timeout`, `lastAttempt`,
`iteration`, `maxIterations`, `lastIteration`, and `previousIteration`.
`number` starts at 1 for each step, and `lastAttempt` is true on its final
allowed visit. `maxAttempts` and `timeout` are `""` when the manifest omits
that limit. On an agent step, `iteration` and `maxIterations` are both `1`,
`lastIteration` is true, and `previousIteration` is `""`. On a Ralph step,
`iteration` starts at 1 on every attempt, `maxIterations` is the step's limit,
and `lastIteration` is true only on the final iteration. `previousIteration` is
`""` on iteration 1; later it has the preceding iteration's `number` and its
`reason`: `no_outcome`, `timeout`, or `nonzero_exit`. `$run.previous` and a
history entry's `new` flag stay the same throughout an attempt. `$run.previous`
is `""` on the first step. Otherwise it follows the
latest `transition` into this step, with `stepId`, `attemptId`, `outcome`,
`message`, `reason`, and `data`. An outcome sets `outcome` and its message,
leaving `reason` empty; a timeout or `onFailure` route sets `reason`, leaving
the other two empty. `data.<step>.<output>` holds every declared output of the
sending step, as that attempt put it or `""`. Test a leaf such as
`$run.previous.data.test.log`, not a map: a map is true even when every value is
`""`. A list or map in a plain placeholder renders as stable,
two-space-indented JSON. `lookup`, `log`, partials, inline
partials and decorators are refused at load. Write `\{{` for literal `{{`. A map
is true in `if`, even when all its values are `""`. A key with no value fills as
empty text. A history read is recorded in `prompt.filled` with the value sources
it read, and a `$run` read records its names.

## Inputs

A manifest declares each input with a description. The short form declares a
required input; the long form can give it a text default. The user gives a value
at launch with `--input <name>=<value>`, and a missing optional input uses its
default. A value is kept under the data key `input.<name>`, and every step can
read it. The step ID `input` is reserved, so no step can put under `input.*`.

```yaml source
formatVersion: 1
inputs:
  issue: the issue number to work on
steps:
  - id: fix
    kind: agent
    harness: claude
    prompt: Fix the issue. Read its number with `loopfile data get input.issue`.
    on:
      done: $success
```

```
loopfile ./fix.loop --input issue=42
```

- A short-form input, or a long-form input without `default`, is required. A
  long-form input with a text `default` is optional.
- A placeholder for an input that the manifest does not declare is a load error.
- An `--input` that is not declared is a launch error. A required input with no
  `--input` or default is a launch error that lists its description; the help
  names optional inputs and their defaults.

## Workspace lifecycle

A run has one workspace, and all steps work in it. The optional top-level
`workspace` field selects its mode; `--workspace <mode>` on launch or `loop`
overrides it. `isolate` is the default; `here` is available only when selected
explicitly. `loopfile check` validates the mode word without inspecting Git or
the target folder.

In `here` mode, the Target folder is the launch folder and is the workspace.
Loopfile does not inspect or modify Git in the Target folder and does not create a workspace folder.
The `LOOPFILE_WORKSPACE` environment variable points to the launch folder, and
`LOOPFILE_SCRATCH` keeps its normal per-attempt path.

In `isolate` mode, the **Target folder** is the Git top level when the launch
folder is inside a Git repository, otherwise it is the launch folder. The
workspace lives at `runs/<runid>/workspace` and follows one of two paths:

1. When Git can make a worktree, it starts from the Target folder's `HEAD` on a
   new branch `loopfile/<runid>`. Uncommitted changes are not carried across;
   launch prints the existing dirty-target warning. Gitignored files are not
   brought into the worktree.
2. Outside Git, in a repository with no commits, or when Git is unavailable,
   Loopfile makes a full copy of the Target folder. This includes gitignored
   files such as `.claude/settings.local.json`. The copy has no branch or base
   commit.

The launch confirmation names the workspace and prints `branch:` only for a
worktree. A successful run removes only a worktree; a copy stays for inspection.
A run that fails, is cancelled, or crashes keeps either workspace. Loopfile
never deletes a run branch; commit inside a worktree if you want the work to
survive on that branch.

`run.created` records `targetFolder`, workspace path and mode. An `isolate` run
also records `isolateKind: worktree` or `copy`. Only a worktree records
`branch` and `baseCommit`; `here` records none of those three fields.
`loopfile result <runid>` hides Git facts when absent; `result --json` keeps the
branch and base commit as empty strings. The JSON format version does not change.

## Operator commands

`loopfile cancel <runid>` stops a run and ends it as cancelled.
`loopfile interrupt <runid>` stops the current attempt and starts a new attempt
of the same step; it fails when the run has ended, crashed, or has no attempt
running. `loopfile resume <runid>` continues a crashed run after the owner is
startable again. `loopfile resume <loopid>` resumes a crashed loop, keeping its
input-source position. It waits for a child that is still running, resumes a
crashed or `internal_error` child first, retries a failed child within the
loop's `--retry` limit, and ends cancelled with detail `run <runid> cancelled` and
no cancel mode if the child was cancelled. Pass
`--kill-leftovers` to kill leftover child processes during that resume. A
pending loop cancellation is honoured before another run starts. Ended loops
must be started again.

## Running from a script

With no terminal, for example in a script or a pipe, `loopfile <source>` and
`loopfile resume <runid>` do not open the monitor. They wait until the run ends.

- stdout gets only the run ID.
- stderr gets AXI confirmation blocks. A completed run ends with:

  ```
  started: <runid>
  ended: <runid> completed
  ```

  A run that does not complete uses the operator failure block:

  ```
  started: <runid>
  error: "run <runid> failed: attempt_limit at step \\\"review\\\""
  code: operation_failed
  help: "...loopfile logs <runid>..."
  ```

- The exit code is `0` when the run completed and `1` when it failed or was
  cancelled. It is `2` when the run owner could not start or crashed. The
  attached monitor uses the same codes when it sees the run end. Detaching
  from it is `0`.

So a plain shell loop can run a Loopfile many times:

```sh
while i=$(next-item); [ -n "$i" ]; do loopfile x.loop --input issue=$i || break; done
```

`-d` does not wait. It prints the run ID and returns `0`.

### Following a run started with `-d`

`loopfile tail <runid>` waits the same way, so a script that started a run with
`-d` can come back to it later:

```sh
runid=$(loopfile x.loop -d)
loopfile tail "$runid" > run.log || echo "run $runid did not complete"
```

- stdout gets activity lines only. Nothing else.
- The exit code is the same as above: `0` the run completed, `1` it failed or
  was cancelled, `2` a Loopfile problem — an unknown run, no activity log yet,
  or a run owner that is gone with no end event.
- A run that does not complete writes the same end text to stderr, except that
  it names the step only when the end event carries one, as an `attempt_limit`
  end does. A Loopfile problem writes an `error:` line instead.

`tail` works on a run that has already ended: it prints the last lines of the
log and returns the same code.

`loopfile tail <runid> --json` prints the run's events instead of its activity
lines. Each stdout line is one line of `events.jsonl` as it is, one JSON object
per line: first every past event, then new ones as the run owner writes them.
It prints a line only once the run owner has finished writing it, stops after
the end event (`run.ended` or `run.cancelled`), and returns the same codes.
Nothing else goes to stdout. The events are a public output, versioned by the
event format version ([ADR 0010](adr/0010-tail-json-events-are-public.md)).

`loopfile tail <loopid>` follows every child run in order. It prints each
child's activity lines and these loop lines: `loop: run <index> <runid> started`,
`loop: run <index> <runid> <state>`, `loop: pause until <time>`, and
`loop: ended <state> <endReason>`. `--json` prints the loop events as written
alongside each child's run events. A missing loop returns `no_such_loop`; a
completed, failed or cancelled loop returns 0, 1 or 1, and a loop owner that is
gone returns 2.

To wait for the run and read how it ended:

```sh
loopfile tail "$runid" --json | jq -c 'select(.type == "run.ended")'
```
