/skill:implement Implement the GitHub issue below in this repository.

The issue:
{{ input.task }}

Rules:

- Follow AGENTS.md. Do not add a suppression under `src/`, and do not edit a bar in
  `quality/quality-ratchet.json`.
- Commit your work to the current branch. Do not push and do not open a pull request.
- When the work is complete and committed, run `loopfile result done`.
- For testing and linting only these are allowed: `npm run format`, `npm run test`, `npm run typecheck` and `npm run gate:quiet` (test step will cover the rest)
  - Do not run `npm run quality:mutation`
- If you cannot go on without a person, run
  `loopfile result blocked --message "<why>"`.
