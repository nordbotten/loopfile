# implement-review

The reference loop: an agent implements, a command tests, an agent reviews.
The loop goes around until review approves.

```text
implement ──done──▶ test ──passed──▶ review ──approved──▶ $success
    ▲                 │                  │
    └──── failed ─────┘                  │
    └──────────── changes_requested ─────┘
```

It needs the `claude` CLI, installed and logged in. The target repository must
have an `npm test` script.

## Run it

Run it from inside the target Git repository. The run works in one worktree
created from that repository's `HEAD`.

```sh
loopfile examples/implement-review --input task="$(cat task.md)"
loopfile pack examples/implement-review        # → implement-review.loop
loopfile implement-review.loop --input task="$(cat task.md)"
```

## The steps

- **`implement`** (Ralph, Claude Code, `effort: high`). Each iteration starts
  with fresh context. Its prompt (`prompts/implement.md`) holds the task, the
  last `test.log` and the last `review.feedback`. It does one small piece of
  work, commits it and keeps notes in `implement.progress`. It reports `done`
  when the work is complete, or `blocked` when it needs a person.
- **`test`** (command). Runs `npm test`, puts the output as `test.log` and
  reports `passed` or `failed`. A crash or a timeout runs `test` again.
- **`review`** (agent, Claude Code, `effort: medium`). Reviews the workspace
  against the task. It reports `approved`, or puts `review.feedback` and
  reports `changes_requested`.

## What the example shows

- **Shared run worktree:** `implement` commits in the workspace. `test` and
  `review` see the same files.
- **Structured results:** every step reports its outcome with `loopfile result`.
  No route uses an exit code.
- **Test failure feedback:** `test` puts `test.log` on every clean exit
  (`outputs: [log]`). `failed` routes to `implement`, which reads it.
- **Review handoffs:** `review` must put `review.feedback` on
  `changes_requested` (map `outputs`). `implement` reads it.
- **Bounded cycles:** `maxIterations`, `maxAttempts`, `timeout`,
  `maxTransitions` and `runTimeout` are all set. `maxAttempts` stops the loop
  first: `test` and `review` may run 5 times each, and `implement` 6 times.
  `maxTransitions: 40` is there to show the field.
