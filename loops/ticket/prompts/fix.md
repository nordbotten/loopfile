You were implementing the GitHub issue below. The work is committed on the current
branch. A check of that work came back with problems. Fix those problems. Do not
start the issue again.

This is fix visit {{ $run.attempt.number }} of at most {{ $run.attempt.maxAttempts }}.

## The issue

{{ input.task }}

{{#if $run.previous}}
## Why you are here

`{{ $run.previous.stepId }}` ended with `{{ $run.previous.outcome }}`.
{{#if $run.previous.data.test.log}}

The test run failed. The end of its log:

{{ $run.previous.data.test.log }}
{{/if}}
{{#if $run.previous.data.review.feedback}}

The review asked for these changes:

{{ $run.previous.data.review.feedback }}
{{/if}}
{{#if $run.previous.data.ship.ci}}

CI failed on the pull request:

{{ $run.previous.data.ship.ci }}
{{/if}}
{{/if}}

## Feedback you already handled

An earlier fix visit handled each item below. Do not work on it again. It is here
so that you know what was asked before and do not undo it.{{!
  Every item except the newest one of the step that sent you here. Each cause
  has its own fix step, so "new since this step's last visit" does not work.
}}{{#if $run.previous.data.review.feedback}}{{#each $history.review.feedback}}{{#unless newest}}

### Review {{ attemptId }}

{{ value }}
{{/unless}}{{/each}}{{else}}{{#each $history.review.feedback}}

### Review {{ attemptId }}

{{ value }}
{{/each}}{{/if}}{{#if $run.previous.data.ship.ci}}{{#each $history.ship.ci}}{{#unless newest}}

### CI failure {{ attemptId }}

{{ value }}
{{/unless}}{{/each}}{{else}}{{#each $history.ship.ci}}

### CI failure {{ attemptId }}

{{ value }}
{{/each}}{{/if}}

## What to do

1. Read `git log origin/main..HEAD` and `git diff origin/main...HEAD` to see the work so far.
2. Fix only what "Why you are here" asks for. If it is a bug, write a failing test first.
3. Do not change anything else. If you see another problem, name it in your commit
   message and leave it.
4. Follow AGENTS.md. Do not add a suppression under `src/`, and do not edit a bar in
   `quality/quality-ratchet.json`.
5. Run `npm run verify` before you finish. Do not run `npm run quality:mutation`.
   The next step runs it.
6. Commit your fix to the current branch. Do not push and do not open a pull request.
7. Run `loopfile result done`. If you cannot go on without a person, run
   `loopfile result blocked --message "<why>"`.
