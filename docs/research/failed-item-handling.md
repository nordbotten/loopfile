# How other runners treat a failed item

This file answers issue #196, part of map #193. It looks at tools that run
many items one after another (or in parallel), and how each tool treats an
item that fails.

For each tool: does it stop or go on; what makes it stop; how it counts
retries; what exit code it gives; does it run a hook when an item ends; does
it record failed items so they can run again.

## GNU parallel

Source: https://www.gnu.org/software/parallel/parallel.html

By default, GNU parallel runs every job. One failed job does not stop it.

`--halt` controls when it stops. The form is `when,why`:
- `when` is `now` (kill running jobs and stop at once) or `soon` (finish
  running jobs, start no new ones).
- `why` is `fail=N`, `fail=N%`, `success=N`, `success=N%`, `done=N`, or
  `done=N%`. `N` is a count. `N%` is a percent of all jobs.

Example: `--halt now,fail=1` stops as soon as one job fails, and kills the
jobs still running.

`--retries n` tries a failed job again, up to `n` times in total. A retry
runs on a different host, if more than one host is set up. `n=0` means retry
without limit.

`--joblog FILE` writes one line per job: sequence number, host, start time,
run time, bytes in, bytes out, exit code, signal, and the command. This is
the record of which jobs failed. `--resume-failed` reads that log and reruns
only the jobs that failed, plus any not yet run. `--retry-failed` reruns
just the failed commands from the log, and ignores the command given on the
command line.

Exit code of `parallel` itself:
- `0`: all jobs ran with no error.
- `1`-`100`: this many jobs failed (or, with a percent halt condition, this
  percent failed).
- `101`: more than 100 jobs failed.
- `255`: some other error.

GNU parallel has no hook that runs a command when one job ends. The
`--joblog` file is a passive record, not a hook.

## make -k / --keep-going

Source: https://www.gnu.org/software/make/manual/html_node/Errors.html,
https://man7.org/linux/man-pages/man1/make.1.html

By default, `make` stops at the first recipe that fails.

`-k` (`--keep-going`) makes `make` go on. It still builds every target that
does not depend on the failed one. It does not hide the failure: `make`
still ends with a nonzero exit code.

A fatal signal to `make` itself (for example Ctrl-C) stops it at once, even
under `-k`. `-k` only changes what `make` does about a recipe's own exit
code, not about a signal sent to `make`.

Exit codes: `0` means every target built with no error. `2` means at least
one recipe failed. (`1` only appears with the `-q` flag, and means a target
needs a rebuild, not that one failed.)

`make` has no retry. A failed recipe line either stops its target, or is
ignored if marked with a leading `-` (or under `.IGNORE`) — it is never run
again. `make` has no hook that runs when a target ends; the closest thing is
`.DELETE_ON_ERROR`, which deletes a partly-built file after a failure. That
is cleanup, not a hook.

## xargs

Source: https://man7.org/linux/man-pages/man1/xargs.1.html

By default, `xargs` keeps running the remaining batches even if one
invocation of the command fails. The one exception: if a command invocation
exits with status **255 exactly**, `xargs` stops at once and reads no more
input. `-x` is a different thing: it stops if one argument line would be
longer than the `-s` limit, not on a command failure.

Exit codes:
- `0`: success.
- `123`: some invocation exited with a status other than 0 or 255.
- `124`: some invocation exited with status **255**.
- `125`: a command was killed by a signal.
- `126`: the command could not be run (found, but not runnable).
- `127`: the command was not found.
- `1`: some other error (for example, a usage error).

`xargs` has no retry option and no per-item hook.

## GitHub Actions: matrix strategy

Source: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax,
https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/running-variations-of-jobs-in-a-workflow,
https://docs.github.com/en/actions/reference/workflows-and-actions/contexts,
https://docs.github.com/en/actions/reference/workflows-and-actions/expressions

`strategy.fail-fast` defaults to `true`. When one matrix job fails, GitHub
cancels every other job in the matrix that is running or queued.

`continue-on-error` can be set on a job or on a step.
- On a step: the step can fail, but the job still passes. GitHub records two
  fields: `outcome` (`failure`, the real result) and `conclusion` (`success`,
  the result used to decide whether to go on). So the failure still shows in
  logs, but it does not block later steps.
- On a job: the same idea, one level up. Other matrix jobs go on even if
  this one fails.

`strategy.max-parallel` only caps how many matrix jobs run at once. It does
not change failure handling.

There is no numeric exit code at the job or workflow level, only a
`conclusion` string: `success`, `failure`, `cancelled`, `skipped`,
`timed_out`, or a few others from the API.

GitHub Actions has no built-in retry for a failed job or step. Retrying
needs a third-party action such as `nick-fields/retry`.

A step can run when a job ends, through an `if:` condition:
- `if: always()` runs no matter what happened before.
- `if: failure()` runs only if an earlier step failed.
- `if: success()` (the default when no condition is given) runs only if
  everything so far passed.

Such a step can read `job.status`, or a named earlier step's
`steps.<id>.outcome` / `steps.<id>.conclusion`.

## GitLab CI: retry and allow_failure

Source: https://docs.gitlab.com/ci/yaml/#retry,
https://docs.gitlab.com/ci/yaml/#allow_failure,
https://docs.gitlab.com/ci/yaml/#after_script,
https://docs.gitlab.com/ci/variables/predefined_variables/

`retry` sets how many times a failed job runs again. Default is `0` (no
retry). Max is `2` (so a job runs up to 3 times in total). By default, any
kind of failure is retried; `retry:when` limits this to certain failure
types (for example `script_failure` only), and `retry:exit_codes` limits it
to certain exit codes. Each retry is a new run of the same job, shown as its
own entry.

`allow_failure: true` means the job can fail, but the pipeline still shows
as passed (with an orange warning). `allow_failure: false` (the normal
default) means a failed job stops later jobs that depend on it.
`allow_failure:exit_codes` sets which exit codes count as an allowed
failure; any other exit code is a real failure.

`after_script` is a hook that runs after the job's main script, whether that
script passed or failed. It runs in its own new shell, with its own
timeout, and it does **not** change the job's own pass/fail result — even if
`after_script` itself fails, the job keeps the result of the main script.
Inside `after_script`, the variable `CI_JOB_STATUS` gives `success`,
`failed`, or `canceled`.

## Sidekiq

Source: https://github.com/sidekiq/sidekiq/wiki/Error-Handling,
https://github.com/sidekiq/sidekiq/wiki/Job-Format,
https://github.com/sidekiq/sidekiq/wiki/Advanced-Options

Sidekiq is a queue worker, not a batch run of a fixed list. It retries a
failed job by default **25 times**, spread over about 21 days, with a
backoff formula that spaces retries further apart each time.

The retry count is stored right on the job's own data, as `retry_count`,
and goes up by one on each failure.

Once a job uses up all its retries, it moves to the **dead set** (kept as
`sidekiq_options dead: true` by default). The dead set holds at most 10,000
jobs for at most 6 months; older jobs drop off first.

`sidekiq_retries_exhausted` is a hook on the job's own class. It runs once,
right when retries run out, and it gets the job's data and the exception
that caused the final failure. A matching global hook,
`config.death_handlers`, runs for every job that dies, class or no class.

Sidekiq has no single "some items failed" exit code, because it is a
long-running process, not a batch tool. Failure shows up instead as the
dead set's size, the retry queue's size, and in its web dashboard.

## Celery

Source: https://docs.celeryq.dev/en/stable/userguide/tasks.html,
https://docs.celeryq.dev/en/stable/userguide/calling.html

Like Sidekiq, Celery is a long-running worker, not a batch tool. A task can
retry itself, through `self.retry()`, `autoretry_for` (a list of exception
types that trigger an automatic retry), and `max_retries` (default `3`).
`retry_backoff` spaces retries further apart each time. The task can read
its own retry count from `self.request.retries`.

Task-level hooks:
- `on_success(self, retval, task_id, args, kwargs)` — after a pass.
- `on_failure(self, exc, task_id, args, kwargs, einfo)` — after a fail.
- `on_retry(self, exc, task_id, args, kwargs, einfo)` — when it retries.
- `after_return(...)` — after any of the above, pass or fail.

`link_error` attaches a separate callback task that runs only when the
first task fails. It gets the failed task's ID, the exception, and its
traceback.

Celery keeps a failed task's state as `FAILURE` in its result store, but it
has no built-in "rerun every failed task" command. A caller would need to
track task IDs itself and requeue the ones in `FAILURE` state.

Like Sidekiq, Celery has no batch exit code; failure shows up per task, in
the result store.

## pytest (a familiar CLI precedent)

Source: https://docs.pytest.org/en/stable/how-to/failures.html,
https://docs.pytest.org/en/stable/how-to/cache.html,
https://docs.pytest.org/en/stable/reference/exit-codes.html

`-x` stops the whole run after the first failed test. It is the same as
`--maxfail=1`. `--maxfail=N` stops after N failed tests.

`--lf` (`--last-failed`) reruns only the tests that failed last time, using
a cache file (`.pytest_cache/v/cache/lastfailed`). If nothing failed last
time, it runs everything (unless told otherwise with `--lfnf=none`).
`--ff` (`--failed-first`) runs every test, but puts last time's failures
first.

Exit codes: `0` all passed, `1` some tests failed, `2` the run was
interrupted, `3` an internal pytest error, `4` a command-line usage error,
`5` no tests were found.

pytest has a hook for the end of each test (`pytest_runtest_logreport`),
and fixture teardown always runs, pass or fail. This is close to a per-item
"on end" hook, though built for plugins, not for the end user.

## Comparison table

| Tool | Stops or goes on by default | What makes it stop | Retry counted | Exit code on partial failure | Hook when item ends | Records failed items to rerun |
|---|---|---|---|---|---|---|
| GNU parallel | Goes on | `--halt now\|soon,fail\|success\|done=N\|N%` | `--retries n`, per job, across hosts | 1-100 = failed count, 101 = capped, 255 = other error | No | Yes, `--joblog` + `--resume-failed`/`--retry-failed` |
| make -k | Stops (goes on with `-k`) | A recipe fails (or a signal to make itself) | None | 0 pass, 2 any recipe error | No (`.DELETE_ON_ERROR` is cleanup) | No |
| xargs | Goes on | Command exits with status 255 | None | 123/124/125/126/127/1, see above | No | No |
| GitHub Actions matrix | Stops (`fail-fast: true` default) | Any matrix job fails | None built in (needs a marketplace action) | No numeric code, `conclusion` string only | Yes, `if: always()`/`failure()` steps | No |
| GitLab CI | Stops, unless `allow_failure: true` | A failed job blocks jobs after it | `retry: 0-2`, per job, by failure type or exit code | Job's own exit code decides pass/fail | Yes, `after_script` (does not change job result) | No (reruns are manual or CI retries) |
| Sidekiq | Goes on (worker keeps running) | Never "stops"; a job dies after 25 retries | `retry_count` on the job, default 25 | No batch exit code (long-running worker) | Yes, `sidekiq_retries_exhausted` / `death_handlers` | Yes, the dead set |
| Celery | Goes on (worker keeps running) | Never "stops"; a task can retry itself | `self.request.retries`, `max_retries` default 3 | No batch exit code (long-running worker) | Yes, `on_failure`/`on_retry`/`link_error` | No built-in rerun-all-failed |
| pytest | Goes on (stops with `-x`/`--maxfail`) | `--maxfail=N` failed tests | None (each test runs once per session) | 0 pass, 1 some failed, 2 interrupted, etc. | Plugin hook per test, not a user hook | Yes, `--lf`/`--ff` from a cache file |

## What this means for loopfile loop

Options only. No decision made here.

- A stop rule could be a plain count (GNU parallel `fail=N`, GitLab `retry`
  max), a percent (GNU parallel `fail=N%`), or "any failure" (GitHub
  Actions' `fail-fast: true` default).
- Retries could count per run, the way GNU parallel's `--retries` and
  Celery's `max_retries` do, separate from the loop's own stop count.
- Stopping could mean "kill the current run" (GNU parallel `now`) or "let
  the current run finish, start no more" (GNU parallel `soon`).
- `loopfile loop` could give a hook a run's outcome and its data, the way
  GitHub Actions' `if: failure()` step reads `job.status`, or Sidekiq's
  `sidekiq_retries_exhausted` reads the job and the exception.
- Failed runs could be recorded for a later rerun, the way GNU parallel's
  `--joblog` feeds `--resume-failed`, and pytest's cache feeds `--lf`.
- Exit code choices range from a plain pass/fail (`make`, most tools) to a
  count of failed items capped at some number (GNU parallel: 1-100, then
  101).
