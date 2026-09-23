/skill:implement Implement the GitHub issue below in this repository.

The issue:
{{ input.task }}

Rules:

- Follow AGENTS.md. Do not add a suppression under `src/`, and do not edit a bar in
  `quality/quality-ratchet.json`.
- Write a test for each acceptance criterion of the issue. A criterion with no test
  is not done.
- Run `npm run verify` before you finish, and fix what it finds. You can run single
  test files with `node --test <file>` while you work.
- Do not run `npm run quality:mutation`. The next step runs it.
- Commit your work to the current branch. Do not push and do not open a pull request.
- List each acceptance criterion with the test that checks it (file and test name),
  one per line, with `loopfile data put implement.criteria -`.
- When the work is complete and committed, run `loopfile result done`.
- If you cannot go on without a person, run
  `loopfile result blocked --message "<why>"`.
