# Loop patterns

Loopfile runs what the manifest says. It has no opinion about how a loop should
look. This page collects patterns that kept real loops running unattended. Each
pattern names the problem, the pattern and a short sample.

The samples are parts of a manifest, not complete manifests. The fields are on
the page [The v1 manifest](manifest-v1.md), and how a run uses them is on the
page [How a run works](runtime.md). The ticket loop of the Loopfile repository
uses every pattern here. To read it:

```sh
loopfile unpack github:nordbotten/loopfile/loops/ticket
```

## One fix step for each cause

**Problem.** `maxAttempts` counts the visits to one step. When one fix step
handles every kind of failure, one cause can use up the visits that another
cause needs. For example, a flaky test uses three visits, and the review has no
visit left for its feedback.

**Pattern.** Give each cause its own fix step and its own budget. The steps can
share one prompt file. `$run.previous` tells the prompt why the run is there.

```yaml
  - id: fix-test
    kind: agent
    harness: claude
    promptFile: prompts/fix.md
    maxAttempts: 4
    on:
      done: test
      blocked: $failure

  - id: fix-review
    kind: agent
    harness: claude
    promptFile: prompts/fix.md
    maxAttempts: 3
    on:
      done: test
      blocked: $failure
```

When several steps read the same `$history`, the `new` flag does not show which
item sent the run here. See [Handoffs and outputs](runtime.md#handoffs-and-outputs).

## A second review gets its first approval

**Problem.** A fix after an approval, for example for a red test, sends the work
through the review again. A reviewer that sees the whole change again can find
new points each time, and the loop does not end.

**Pattern.** On approval, put the commit and the notes. On the next visit, show
them to the reviewer, and ask it to review only the commits after that commit.
Code that was approved stays approved.

```yaml
  - id: review
    kind: agent
    harness: claude
    promptFile: prompts/review.md
    outputs:
      feedback: [changes_requested]
      notes: [approved]
      sha: [approved]
    on:
      approved: ship
      changes_requested: fix-review
```

```handlebars
{{#if review.sha}}
You approved commit `{{ review.sha }}` with these notes:

{{ review.notes }}

Review only the commits since then: `git log {{ review.sha }}..HEAD`.
Block only on a bug in those commits.
{{else}}
Review the whole change.
{{/if}}

When you approve, run `git rev-parse HEAD | loopfile data put review.sha -`.
```

## A flaky check is not work for an agent

**Problem.** A test that fails once and passes the next time sends the run to a
fix step. The agent looks for a bug that is not in the change, and it uses a
visit.

**Pattern.** In the command step, run a failed check once more. A pass the
second time is a flake. Record it as data, and go on as passed.

```yaml
  - id: test
    kind: command
    run: |
      if ! npm test > "$LOOPFILE_SCRATCH/test.log" 2>&1; then
        mv "$LOOPFILE_SCRATCH/test.log" "$LOOPFILE_SCRATCH/flake.log"
        if ! npm test > "$LOOPFILE_SCRATCH/test.log" 2>&1; then
          loopfile data put test.log "$LOOPFILE_SCRATCH/test.log"
          loopfile result failed
          exit 0
        fi
        loopfile data put test.flake "$LOOPFILE_SCRATCH/flake.log"
      fi
      loopfile result passed
    outputs:
      log: [failed]
    on:
      passed: review
      failed: fix-test
```

`test.flake` is not in `outputs`, because the step puts it only sometimes.

## Merge the target branch before the test

**Problem.** When runs work in parallel, other runs merge while this run works.
A conflict found only at the end is large, and a fix step for test failures is
the wrong place for it.

**Pattern.** Merge the target branch at the start of each test. Send a conflict
to its own resolve step, with the conflicting files as data.

```yaml
  - id: test
    kind: command
    run: |
      git fetch origin main
      if ! git merge --no-edit origin/main > "$LOOPFILE_SCRATCH/merge.txt" 2>&1; then
        git diff --name-only --diff-filter=U >> "$LOOPFILE_SCRATCH/merge.txt"
        loopfile data put test.conflict "$LOOPFILE_SCRATCH/merge.txt"
        loopfile result conflict
        exit 0
      fi
      # ... the checks
    outputs:
      conflict: [conflict]
    on:
      conflict: resolve
      # ...
```

## One run at a time on a shared resource

**Problem.** Two runs that merge to the same branch at the same time make each
other out of date. Each one then waits for its checks again, and they can do
this over and over.

**Pattern.** Hold a lock in the step that uses the shared resource. The lock
is released when the step ends. The step's `timeout` and the `runTimeout` must
include the time a run waits for the lock.

```yaml
runTimeout: 4h
steps:
  - id: ship
    kind: command
    run: |
      exec 9> "$HOME/.my-loop/ship.lock"
      flock 9
      # ... merge, push, wait for CI, merge the PR
    timeout: 2h
```

## Size a check to the change, not to the timeout

**Problem.** A check whose cost grows with the files it covers, for example
mutation testing, becomes slower as the repository grows. A small change in a
large file one day takes longer than the step timeout, and the run fails with
correct work.

**Pattern.** Limit the check to what the change touched: the files or lines
since the target branch. A longer timeout only moves the failure to a later
day.

```sh
git diff -U0 --merge-base origin/main -- src    # the changed lines
```

## Keep the queue outside the loop

**Problem.** A loop does one item of work. Deciding which item is next, and
what to do when a run fails, belongs to the team that owns the queue.

**Pattern.** Start runs from a script, or with `loopfile loop --next <command>`.

- `loopfile loop` ends at the first run that still fails after `--retry`. That
  is the safe default. When a queue must go on after a failure, drive
  `loopfile <source>` or `loopfile tail <runid>` from your own script and use
  the exit code (see [Running from a script](runtime.md#running-from-a-script)).
- Take an item out of the queue before its run starts, so that a second driver
  does not pick it too.
- When a run fails, report it where people look, for example on the issue, and
  take the item out of the queue. Push the run branch
  (`loopfile/<runid>`), so the work is not lost.
- Stop after a few failures in a row. Then the problem is likely in the loop or
  the machine, not in the items.
- Do not run two items that change the same files at the same time. They end in
  merge conflicts.
