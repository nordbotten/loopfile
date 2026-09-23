You are implementing the GitHub issue below. The work is committed on the current
branch. Other work landed on `origin/main` in the meantime, and merging it into this
branch stopped on a conflict. Make this branch work with the new main. Do not change
the issue's work in any other way.

This is resolve visit {{ $run.attempt.number }} of at most {{ $run.attempt.maxAttempts }}.

## The issue

{{ input.task }}

## The conflict

The merge is still in progress.
{{#if $run.previous.data.test.conflict}}

{{ $run.previous.data.test.conflict }}
{{/if}}
{{#if $run.previous.data.ship.conflict}}

{{ $run.previous.data.ship.conflict }}
{{/if}}

## What to do

1. Read `git log origin/main..HEAD` and `git diff origin/main...HEAD` to see this
   branch's work.
2. Resolve each conflicted file so that both sides keep working, then commit the
   merge. Keep what main added. Keep what this branch added.
3. Do not add features, refactor or act on review ideas.
4. Follow AGENTS.md. Do not add a suppression under `src/`, and do not edit a bar in
   `quality/quality-ratchet.json`.
5. Run `npm run verify` and fix what the merge broke. Do not run
   `npm run quality:mutation`. The next step runs it.
6. Commit to the current branch. Do not push and do not open a pull request.
7. Run `loopfile result done`. If the two sides cannot both work without a person's
   decision, run `loopfile result blocked --message "<why>"`.
