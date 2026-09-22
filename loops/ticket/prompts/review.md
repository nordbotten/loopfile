Review the change on the current branch against the GitHub issue below.

The issue:
{{ input.task }}

Your last review of this branch (empty on the first review):
{{ review.feedback }}

See the change with `git diff origin/main...HEAD` and `git log origin/main..HEAD`.
The tests and the quality gate have passed.

If there is a last review, first check that each point in it is fixed.

Request changes only for these:

- An acceptance criterion of the issue is not met.
- A bug: the branch gives wrong behaviour in code it changed, or in behaviour the
  issue asks for.
- An AGENTS.md rule is broken: a suppression under `src/`, an edited bar in
  `quality/quality-ratchet.json`, or a filesystem, process or harness SDK import
  in `CORE`.
- A point of your last review that is not fixed.
- A behaviour the issue asks for that no test checks.

Do not request changes for style, names, small cleanups, problems that were already
on `origin/main` and are outside the issue, or ideas for more work. These do not
block. Write the most useful ones as notes. The notes go in the pull request body.

If nothing blocks, write your notes as a short list with
`loopfile data put review.notes -`, or write `none`. Then run `loopfile result approved`.

If something blocks, write only the blocking points as a short list with
`loopfile data put review.feedback -`, then run `loopfile result changes_requested`.
