Review the change on the current branch against the GitHub issue below.

The issue:
{{ input.task }}

The implementer's list of each acceptance criterion and the test that checks it:
{{ implement.criteria }}

The tests, the quality gate and mutation testing have passed.
{{#if review.sha}}

## You approved this branch before

You approved commit `{{ review.sha }}` with these notes:

{{ review.notes }}

Since then the branch came back to you after a merge of main, a conflict
resolution, a fix for a red CI or a fix for a failed test. Review only what
changed since `{{ review.sha }}`:

- `git log --oneline {{ review.sha }}..HEAD` lists the new commits.
- `git show --remerge-diff <commit>` shows how a merge of `origin/main` resolved
  each conflict. Code that main brought in is not this branch's work.
- `git show <commit>` shows each other new commit.

The code you approved at `{{ review.sha }}` stays approved. Do not raise new points
on it, and do not turn a note into a blocker. Request changes only for a bug in
the new commits, or for a new commit that breaks an acceptance criterion or an
AGENTS.md rule.
{{else}}

See the change with `git diff origin/main...HEAD` and `git log origin/main..HEAD`.
{{#if review.feedback}}

Your last review asked for these changes. First check that each point is fixed:

{{ review.feedback }}
{{/if}}

Request changes only for these:

- An acceptance criterion of the issue is not met.
- An acceptance criterion has no test that checks it.
- A bug: the branch gives wrong behaviour in code it changed, or in behaviour the
  issue asks for.
- An AGENTS.md rule is broken: a suppression under `src/`, an edited bar in
  `quality/quality-ratchet.json`, or a filesystem, process or harness SDK import
  in `CORE`.
- A point of your last review that is not fixed.
{{/if}}

Do not request changes for style, names, small cleanups, problems that were already
on `origin/main` and are outside the issue, or ideas for more work. These do not
block. Write the most useful ones as notes. The notes go in the pull request body.

If nothing blocks:

1. Write your notes as a short list with `loopfile data put review.notes -`, or
   write `none`.{{#if review.sha}} Keep the notes of your earlier approval that
   still apply.{{/if}}
2. Record the commit you approved: `git rev-parse HEAD | loopfile data put review.sha -`.
3. Run `loopfile result approved`.

If something blocks, write only the blocking points as a short list with
`loopfile data put review.feedback -`, then run `loopfile result changes_requested`.
