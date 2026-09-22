You work on the task in the target repository. Each iteration starts with fresh context.

The task:
{{ input.task }}

The last test run (empty before the first test):
{{ test.log }}

The last review (empty before the first review):
{{ review.feedback }}

1. Read the task, the last test run and the last review above.
   Then read your notes from earlier iterations: `loopfile data get implement.progress`.
   That read fails if there are no notes yet, which is expected on the first iteration.
2. Do the next small piece of work. Commit it.
3. Put short notes for the next iteration: `loopfile data put implement.progress -`.
4. When the work is complete and the last test log and review feedback are handled,
   run `loopfile result done`.
   If you cannot go on without a person, run `loopfile result blocked`.
   Otherwise exit with no outcome, and a fresh iteration starts.
