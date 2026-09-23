# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Tickets for the ticket loop

`scripts/run-ticket.sh` works `ready-for-agent` tickets in parallel. It starts at
most one run per **area**, because tickets in one area change the same files and
parallel runs on them end in merge conflicts. When you publish tickets (for
example with `/to-tickets`):

- **Give each ticket a parent.** Link it as a GitHub sub-issue of its spec or map
  issue. The parent is the ticket's area. A ticket with no parent can have an
  `area:<name>` label instead. A ticket with neither runs in parallel with
  everything.
- **Keep a ticket to about 10 changed files.** Split a ticket that you expect to
  change more. A large ticket gives hundreds of mutants and a slow test step.
- **Write each acceptance criterion so one test can check it.** The loop's review
  blocks a criterion that has no test.

## Pull request titles

PRs are squash-merged, so a PR title becomes the commit title on `main`.
release-please reads these titles to pick the next version and to write
`CHANGELOG.md`. So every PR title is a
[Conventional Commit](https://www.conventionalcommits.org/) title:

```text
<type>[(scope)][!]: <summary>
```

| Type | Use it for | Next version from 0.1.0 | In `CHANGELOG.md` |
| --- | --- | --- | --- |
| `feat` | a change a user can see or use | 0.2.0 | yes |
| `fix` | a bug fix | 0.1.1 | yes |
| `perf` | the same behavior, faster | 0.1.1 | yes |
| `revert` | undo an earlier PR | 0.1.1 | yes |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore` | changes a user does not see | none | no |

- Write the summary as a user would say it: `feat: status shows the loop and
  its recent runs`, `fix(cli): list shows the right STEP for a completed run`,
  `docs: ADR 0014 for workspace modes`.
- The scope is optional, in lower case: `fix(tail): ...`.
- Add `!` after the type or scope when a user must change what they do, for
  example `feat!: rename --max-runs to --runs`. Before 1.0 this gives the next
  minor version, not 1.0.0.

`scripts/check-pr-title.sh "<title>"` checks a title. The `PR title` workflow
runs it on every PR.

### Releases

The `Release` workflow keeps one open release PR, with a title that starts with
`chore(main): release`. It holds the next version and the new `CHANGELOG.md` entries. To release, merge
it with `gh pr merge <number> --squash --admin`. `--admin` is necessary because
CI does not run on a PR that GITHUB_TOKEN opens. The merge tags `v<version>`,
makes the GitHub Release and stages the package on npm. The version goes live
only when a maintainer approves it with 2FA: `npm stage list loopfile`, then
`npm stage approve <id>`, or on npmjs.com. An agent never approves a stage.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
