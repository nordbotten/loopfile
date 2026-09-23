#!/usr/bin/env bash
# Fails when $1 is not a Conventional Commits title. PRs are squash-merged, so
# the PR title is the commit on main that release-please reads to pick the next
# version and write CHANGELOG.md. See docs/agents/issue-tracker.md.
set -euo pipefail

re='^(feat|fix|perf|revert|refactor|docs|test|build|ci|chore)(\([a-z0-9-]+\))?!?: [^ ]'
if [[ ! ${1-} =~ $re ]]; then
  echo "Not a Conventional Commits title: ${1-}" >&2
  echo "Use <type>[(scope)][!]: <summary>, for example 'feat: status shows the loop'." >&2
  echo "See docs/agents/issue-tracker.md#pull-request-titles." >&2
  exit 1
fi
