#!/usr/bin/env bash
# Pick one ready issue of the current repo and start a run of loops/ticket on
# it. Run it from the repo, on main.
#
#   run-ticket.sh [--merge] [--no-ci]
#                            pick the lowest ready issue and start a run;
#                            --no-ci ships without waiting for CI
#   run-ticket.sh --loop [--merge] [--no-ci]
#                            follow each run with tail, then start the next.
#                            A run that does not complete gets its branch
#                            pushed, a comment on its issue and the label
#                            agent-failed, and the loop goes on. Stop after 3
#                            runs in a row that do not complete, or when no
#                            issue is ready. When the only ready issues are
#                            held back by an area in flight, wait 5 minutes
#                            and pick again
#   run-ticket.sh --dry-run  only print the issue it would pick
#
# It uses the loopfile on PATH, as a user does. To run the loopfile of this
# repo, install it: npm run build && npm i -g "$(npm pack)". Each run copies
# loops/ticket when it starts, so a later merge does not change a run in
# flight. The run owner starts under nice -n 10, so every step, agent and test
# process of the run is niced too.
set -euo pipefail
shopt -s inherit_errexit  # keep set -e inside $(start)

root=$(git rev-parse --show-toplevel)

merge=no
ci=yes
dry_run=no
loop=no
for arg in "$@"; do
  case "$arg" in
    --merge) merge=yes ;;
    --no-ci) ci=no ;;
    --dry-run) dry_run=yes ;;
    --loop) loop=yes ;;
    *) echo "usage: $0 [--merge | --no-ci | --loop | --dry-run]" >&2; exit 2 ;;
  esac
done

# The ready issue with the lowest number: no assignee, no open linked PR, no
# area in flight and every issue in its "## Blocked by" section closed. An
# issue's area is its parent issue, else its first area:* label; with neither
# it has no area. An area is in flight when an assigned ready issue has it.
# Returns 1 when no issue is ready, 2 when no issue is picked but at least one
# was held back by its area, 3 when the issues cannot be listed.
pick() {
  local json open n held blocker area_skipped=no
  # One GraphQL list, not a search: the search index lags, so a loop that
  # picks just after another would still see the issue as free.
  # shellcheck disable=SC2016  # $owner and the like are GraphQL variables
  json=$(gh api graphql --paginate -F owner='{owner}' -F name='{repo}' -f query='
    query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        issues(first: 100, after: $endCursor, states: OPEN, labels: ["ready-for-agent"]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number body assignees { totalCount } parent { number }
            labels(first: 50) { nodes { name } }
            closedByPullRequestsReferences(first: 20) { nodes { state } }
          }
        }
      }
    }' --jq '.data.repository.issues.nodes[]') || return 3
  open=" $(jq -rs 'map(.number) | join(" ")' <<< "$json") "
  while read -r n held; do
    [ "$held" = false ] || { area_skipped=yes; continue; }
    for blocker in $(jq -rs --argjson n "$n" '.[] | select(.number == $n) | .body' <<< "$json" |
      awk '/^## Blocked by/{f=1;next} /^## /{f=0} f' | grep -oE '#[0-9]+' | tr -d '#'); do
      # A blocker in the ready list is open, so it needs no API call.
      [[ $open != *" $blocker "* ]] || continue 2
      [ "$(gh issue view "$blocker" --json state -q .state)" = CLOSED ] || continue 2
    done
    echo "$n"
    return 0
  done < <(jq -rs '
    def area: if .parent then "#\(.parent.number)"
      else [.labels.nodes[].name | select(startswith("area:"))][0] // "" end;
    [.[] | select(.assignees.totalCount > 0) | area | select(. != "")] as $flight
    | map(select(.assignees.totalCount == 0
        and all(.closedByPullRequestsReferences.nodes[]; .state != "OPEN")))
    | sort_by(.number)[]
    | "\(.number) \(area as $a | $flight | index([$a]) != null)"' <<< "$json")
  [ "$area_skipped" = no ] || return 2
  return 1
}

# Picks one issue and starts a run on it. Prints "<runid> <issue>" on stdout,
# or nothing when no issue is ready or on a dry run.
start() {
  local issue title task runid rc
  # Loops that start at the same time would pick the same issue or area, so
  # only one picks and assigns at a time. The lock is shared by every loop.
  mkdir -p "$HOME/.loopfile/ticket"
  while :; do
    exec 9> "$HOME/.loopfile/ticket/pick.lock"
    flock 9
    rc=0
    issue=$(pick) || rc=$?
    [ "$rc" = 2 ] && [ "$loop" = yes ] && [ "$dry_run" = no ] || break
    exec 9>&-  # other loops can pick while this one waits
    echo "every ready issue is in an area in flight, waiting 5 minutes" >&2
    sleep 300
  done
  case $rc in
    0) ;;
    1) echo "no ready issue" >&2; return 0 ;;
    2) echo "no ready issue outside the areas in flight" >&2; return 0 ;;
    *) echo "could not list the ready issues" >&2; return 1 ;;
  esac
  title=$(gh issue view "$issue" --json title -q .title)
  echo "issue: #$issue $title" >&2
  [ "$dry_run" = no ] || return 0

  # A run starts from HEAD, so launch from an up-to-date main.
  [ "$(git -C "$root" branch --show-current)" = main ] || { echo "check out main in $root first" >&2; exit 2; }
  git -C "$root" pull --ff-only >&2

  gh issue edit "$issue" --add-assignee @me > /dev/null
  exec 9>&-  # before the run starts, so its owner does not hold the lock
  task="#$issue $title

$(gh issue view "$issue" --json body -q .body)"
  runid=$(cd "$root" && nice -n 10 loopfile loops/ticket -d \
    --input task="$task" --input issue="$issue" --input merge="$merge" --input ci="$ci")
  echo "$runid $issue"
}

# A run that did not complete: push its branch when it has new commits, tell
# the issue where the run ended, and take the issue out of the ready queue.
# An open PR of the run stays open.
report_failure() {
  local runid=$1 issue=$2 branch="loopfile/$1" events step reason pushed
  events="${LOOPFILE_HOME:-$HOME/.loopfile}/runs/$runid/events.jsonl"
  step=$(jq -rs '(map(select(.type == "run.ended")) | last | .stepId)
    // (map(select(.type == "attempt.ended")) | last | .attemptId | sub("^[0-9]+-"; ""))
    // "unknown"' "$events" 2> /dev/null) || step=unknown
  reason=$(jq -rs '(map(select(.type == "run.ended")) | last
      | if . then "\(.result) (\(.reason))" else "the run did not end" end)
    + (map(select(.type == "attempt.ended")) | last
      | if . then "; last attempt \(.attemptId): \(.result), "
          + (if .outcome then "outcome \(.outcome)" else .reason end) else "" end)' \
    "$events" 2> /dev/null) || reason=unknown
  if [ -z "$(git -C "$root" log --oneline "origin/main..$branch" 2> /dev/null)" ]; then
    pushed="no commits"
  elif git -C "$root" push -q origin "$branch" >&2; then
    pushed="pushed \`$branch\`"
  else
    pushed="\`$branch\` has commits, but the push failed"
  fi
  echo "run $runid did not complete: step $step, $reason, $pushed" >&2
  gh issue comment "$issue" --body "The ticket loop run \`$runid\` did not complete.

- step: \`$step\`
- reason: $reason
- branch: $pushed" > /dev/null || echo "could not comment on #$issue" >&2
  gh issue edit "$issue" --remove-assignee @me --remove-label ready-for-agent \
    --add-label agent-failed > /dev/null || echo "could not relabel #$issue" >&2
}

started=$(start)
[ -n "$started" ] || exit 0
read -r runid issue <<< "$started"
echo "run: $runid (#$issue)"
if [ "$loop" = no ]; then
  echo "follow: loopfile tail $runid"
  exit 0
fi

# tail exits 0 only when the run completed. A run that does not complete does
# not stop the loop, but 3 of them in a row do.
fails=0
while :; do
  if loopfile tail "$runid"; then
    fails=0
  else
    report_failure "$runid" "$issue"
    fails=$((fails + 1))
    [ "$fails" -lt 3 ] || { echo "3 runs in a row did not complete, stopping" >&2; exit 1; }
  fi
  started=$(start)
  [ -n "$started" ] || exit 0
  read -r runid issue <<< "$started"
  echo "run: $runid (#$issue)"
done
