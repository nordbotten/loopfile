Write the pull request title and description for the work on the current branch.
Do not change, commit or push code.

## The issue

{{ input.task }}

## The acceptance criteria and their tests

{{ implement.criteria }}

## What to do

1. Read `git log --oneline origin/main..HEAD` and `git diff origin/main...HEAD`.
   Describe what the diff does, not what the issue asked for.
2. Write the title as the section "Pull request titles" of
   `docs/agents/issue-tracker.md` tells. Pick the type from what the diff changes
   for a user. Add `!` only when a user must change what they do. Check the title
   with `scripts/check-pr-title.sh "<title>"`, and change it until the check passes.
3. Set the title:

   ```sh
   printf '%s\n' "<title>" | loopfile data put describe.title -
   ```

4. Write the description in Markdown to a file:
   - Start with one or two sentences: what changes for a user, and why.
   - `## Changes`: one line for each change that a reviewer must know about. Do
     not list every file.
   - `## Tests`: each acceptance criterion with its test.
   - Do not write `Closes #...`. The ship step adds it.
   - Do not write the words `BREAKING CHANGE`. The `!` in the title marks a
     breaking change.
5. Set the description:

   ```sh
   loopfile data put describe.body <file>
   ```

6. Run `loopfile data get describe.title` and `loopfile data get describe.body`,
   and check that each one is what you wrote.
7. Run `loopfile result done`. If you cannot go on without a person, run
   `loopfile result blocked --message "<why>"`.
