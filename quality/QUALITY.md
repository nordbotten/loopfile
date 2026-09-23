# Quality guardrails

The stack rests on one idea: `quality-zones.mjs` is the single source of truth
for what each source file means, and every other tool reads that map. A file has
exactly one zone, so the import rule and the bars can never disagree about it.

Files always come from `git ls-files`, never from a glob. Git already knows what
belongs to the project, including the local exclusions that keep an agent's
worktree under `.claude/worktrees/` out of the way. A glob walks into those
worktrees and reads another branch's code as if it were yours.

The listing includes files that are written but not yet staged, so a new file is
checked while you are still writing it rather than after it is committed.

## Zones

| Zone | Where | What it means |
| --- | --- | --- |
| `CORE` | `src/domain/`, `src/application/`, any other `src/*.ts` | Pure logic: the workflow model, the loader, routing, the run owner's decisions |
| `BOUNDARY` | `src/adapters/` | The explicit side-effect edge: filesystem, processes, git, harnesses |
| `EXEMPT` | `src/cli.ts` | The CLI entry point. Argument parsing and process wiring, no logic |
| `TESTS` | `src/**/*.test.ts` | An exclusion, not a measured zone |

A `src/*.ts` the map does not name defaults to `CORE`, the strictest zone. A new
file is pure until it proves otherwise, and one that cannot honour the import
rule moves under `src/adapters/` rather than argues with the map. Only a file in
an unknown *directory* under `src/` fails as unclassified, because a new
top-level directory is a decision, not an oversight.

## Entry points

```text
npm run verify                # build, lint, gate:quiet and the checks' own tests
npm run quality               # every check, every result, ALWAYS exits 0
npm run gate                  # every check, every result, exits 1 if any failed
npm run gate:quiet            # the same gate, reported for repair
npm run quality:mutation      # mutation testing over CORE (slower, runs alone)
npm run quality:ratchet       # no bar has been loosened against origin/main
npm test                      # the suite, including the checks' own tests
```

`quality` reports and never fails, which is what you want when you are looking
at the state of things. `gate` is the same run with an exit code.

`verify` is the one check that CI's `check` job, the ticket loop and agents all
run. It adds the build, lint and the checks' own tests to `gate:quiet`, so a
branch that passes it locally passes CI's `check` job too.

`gate:quiet` is for local repair. Every check still runs, and each one still
gets a block saying what it answers and whether it passed — but a passing check
stops there, and a failing one adds its bar, the single command that confirms
the fix, and its diagnostics *with the passing lines stripped out*. A failing
checker prints everything that went right next to the one thing that did not;
quiet drops that so you are looking at the repair and nothing else.

Both loud modes keep each checker's own output in full, so quiet reporting never
becomes the only way to see it.

Every check is also its own command: `quality:zones`, `quality:suppressions`,
`quality:imports`, `quality:coverage`.

## Suppressions

`quality-suppressions.mjs` fails if `@ts-ignore`, `@ts-expect-error`,
`@ts-nocheck`, `biome-ignore`, `eslint-disable`, an `istanbul`/`c8`/`v8` ignore,
a skipped, focused or todo test, or a `Stryker disable` comment (including
`disable next-line` and a mutator-name form like `Stryker disable
EqualityOperator: reason`) appears anywhere under `src/`. A bare `Stryker
restore` is not flagged — it is harmless without a matching `disable`.

Unlike every other check it has no exception list, no allowlist and no
environment escape. A suppression comment disables the very measurement the
other checks depend on, so it is never something to grandfather. If one is ever
genuinely required, change the rule deliberately, with a human reading the diff.

## The import rule

`CORE` may not import the filesystem, `node:child_process`, `node:os`, the
network modules, `node:worker_threads`, or a harness SDK. `BOUNDARY` and
`EXEMPT` are unrestricted — they are where those details live.

This is the structural half of ADR 0009 and the reason the zone map exists.
Loopfile's product is a deterministic runtime, and "deterministic" only survives
while the routing and transition logic can be tested without a disk or a
process. A `CORE` file reaching for one of these is telling you it belongs under
`src/adapters/`.

## Enforcement

`.github/workflows/ci.yml` runs three jobs on every pull request and every push
to `main`: `check` (build, typecheck, lint, test), `gate` (the ratchet, then the
four checks) and `mutation`. All run on the repository's self-hosted runners,
labelled `self-hosted, Linux, X64`.

Runs are grouped by ref and cancel their own superseded runs. There are two
runners for the whole repository, so a run nobody is waiting for should give its
runner back rather than make the next one queue.

The workflow is advisory: nothing blocks a red merge. Branch protection and
rulesets are the feature that would, and they are not available on a private
repository on a free personal account. So the gate reports the truth and cannot
stop you.

There is deliberately no `pre-push` hook. A hook in a repo where agents push
from worktrees gets bypassed the first time it is inconvenient, and nobody sees
it happen. CI is the honest place for this, because its result is visible.

## When this repository goes public

Two changes, both decided in advance:

1. **Move CI to GitHub-hosted runners.** Change every `runs-on` in `ci.yml` to
   `ubuntu-latest`. On a public repository anyone can fork and open a pull
   request, and `pull_request` workflows run that pull request's code — running
   a stranger's code on a self-hosted runner in someone's home is the risk
   GitHub warns about. Public repositories get free hosted minutes, so the
   reason for local runners disappears exactly when they become a problem.
2. **Add a ruleset on `main`** requiring the `check`, `gate` and `mutation`
   status checks. Rulesets are free on public repositories. This is the point
   where the gate stops reporting and starts blocking.

## Not here on purpose

Adapted from a larger stack, with roughly half of it deliberately left behind:

- **No complexity budgets.** They need ESLint as a second linter beside Biome.
  CRAP already punishes code that is both complex and untested.
- **No risk-guard label job.** There is no PR review process to hang it on yet.
- **No exception lists.** At this size there is nothing to grandfather, and an
  empty list the ratchet forbids adding to is the same as no list. The mechanism
  arrives with the first genuine unfixable case, reviewed by a human.
- **No `VIEW` or `VENDOR` zone.** There is no UI and no generated source.
- **No operating-system matrix.** One Linux runner class. A per-platform matrix
  earns its place when the code itself branches on platform, and then the thing
  to fix is the branching.

## Coverage and CRAP

`quality-coverage.mjs` runs the suite under `c8` once and answers two questions
from the one report. Coverage asks whether the code ran. CRAP asks a sharper
version of it:

```text
CRAP = complexity^2 * (1 - coverage)^3 + complexity
```

A function that is both branchy and thinly covered scores badly, and the only
ways down are more tests or less branching. Note the shape: at full coverage
CRAP equals complexity, so a ceiling of 10 is also a complexity cap of 10 for
code that is fully tested. That is the intended reading, not a side effect.

Coverage comes from `c8` in Istanbul format rather than V8's own, because CRAP
needs the per-function statement data only the Istanbul report carries. `c8`
writes one entry per branch *path*, not per decision, plus a `column: -1` entry
for an `if` with no `else` and one entry at each function's own start. The
complexity count drops those two, which is what makes it agree with a hand count.

`EXEMPT` and `TESTS` are not measured.

## Mutation

`npm run quality:mutation` runs Stryker over the `CORE` files the branch changed
since it left `origin/main`, committed or not. It changes the code
underneath the tests — flips a comparison, empties a block, narrows a regex —
and any change no test complains about is a hole a coverage number cannot see.

`node --test` writes TAP, so it uses Stryker's tap runner with per-test
coverage. Each test file counts as one test, and a mutant runs only the test
files that reach it. End-to-end tests that start processes, import the fake
harness, build git repositories or wait on real timers are left out, because a
mutant that makes a run hang costs a full timeout. The exclusion list in
`stryker.config.mjs` includes every tracked test importing `node:child_process`
or `./fake-harness.test.ts`; `quality-tools.test.mjs` checks that rule. `gate`
and `check` still run these files. If mutation testing stops being fast, scope
the run rather than lower the bar.

A branch that changes no `CORE` file mutates nothing and passes, and the bar
applies to the changed files only. So a change that only removes or weakens
tests is not caught here. Review has to catch it.

It is a separate command and its own CI job, because the gate is meant to be
cheap enough to run constantly.

## Ratchets

`quality-ratchet.json` is the only home for the coverage, CRAP and mutation
bars. The standards were set on 2026-09-18: `CORE` 90/85/90/90
(statements/branches/functions/lines), `BOUNDARY` 70/60/70/70, CRAP at most 10,
mutation at least 75 over `CORE`.

They are standards chosen, not measurements copied. `CORE` carries the higher
branch floor because routing and transition bugs hide in branches, and routing
is the product. `BOUNDARY` is lower so vendor and transport failure paths are
not forced into `CORE` just to reach a number.

`quality-ratchet-check.mjs` compares the working file with the base ref:
coverage and mutation floors may only rise, the CRAP ceiling may only fall.
Without it the cheapest way past a failing gate is to edit the bar, and that
edit looks like ordinary work in a busy diff.

On `main` there is no base, so the check reports and passes. A bar can therefore
only be loosened by a direct push to `main`, which is the captain's to make.
