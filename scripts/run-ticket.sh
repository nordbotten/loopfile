#!/usr/bin/env bash
# Pick one ready issue of the current repo and start its ticket loop with a
# pinned loopfile and a pinned, packed loop. Run it from the repo, on main.
#
#   run-ticket.sh pin        build loopfile from the repo and pack loops/ticket
#                            into $LOOPFILE_PIN
#   run-ticket.sh [--merge] [--no-ci]
#                            pick the lowest ready issue and start a run;
#                            --no-ci ships without waiting for CI
#   run-ticket.sh --loop [--merge] [--no-ci]
#                            follow each run with tail, then start the next;
#                            stop when a run does not complete or no issue is
#                            ready
#   run-ticket.sh --dry-run  only print the issue it would pick
#
# The pinned loopfile is on PATH only for the run, so the run owner, the steps
# and the agents all use it. Merged changes to loopfile or to loops/ticket do
# not reach a run until the next pin.
set -euo pipefail
shopt -s inherit_errexit  # keep set -e inside $(start)

root=$(git rev-parse --show-toplevel)
pin=${LOOPFILE_PIN:-$HOME/.loopfile/ticket/pin}

if [ "${1:-}" = pin ]; then
  (cd "$root" && npm run build)
  rm -rf "$pin"
  mkdir -p "$pin/bin"
  cp -r "$root/dist" "$root/package.json" "$pin/"
  (cd "$pin" && npm install --omit=dev --no-package-lock --ignore-scripts --no-audit --no-fund)
  chmod +x "$pin/dist/cli.js"
  ln -s ../dist/cli.js "$pin/bin/loopfile"
  "$pin/bin/loopfile" pack "$root/loops/ticket" -o "$pin/ticket.loop" > /dev/null
  echo "pinned: $pin ($(git -C "$root" rev-parse --short HEAD))"
  exit 0
fi

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
    *) echo "usage: $0 [pin | --merge | --no-ci | --loop | --dry-run]" >&2; exit 2 ;;
  esac
done

# The ready issue with the lowest number: no assignee, no open linked PR and
# every issue in its "## Blocked by" section closed.
pick() {
  local n body blocker
  # Not --search no:assignee: the search index lags, so a loop that picks just
  # after another would still see the issue as free.
  for n in $(gh issue list --label ready-for-agent --state open --json number,assignees \
    --limit 200 -q '.[] | select(.assignees == []) | .number' | sort -n); do
    [ -z "$(gh issue view "$n" --json closedByPullRequestsReferences \
      -q '.closedByPullRequestsReferences[] | select(.state == "OPEN") | .number')" ] || continue
    body=$(gh issue view "$n" --json body -q .body)
    for blocker in $(awk '/^## Blocked by/{f=1;next} /^## /{f=0} f' <<< "$body" | grep -oE '#[0-9]+' | tr -d '#'); do
      [ "$(gh issue view "$blocker" --json state -q .state)" = CLOSED ] || continue 2
    done
    echo "$n"
    return 0
  done
  return 1
}

[ "$dry_run" = yes ] || [ -f "$pin/ticket.loop" ] || { echo "nothing pinned, run: $0 pin" >&2; exit 2; }

# Picks one issue and starts a run on it. Prints the run ID on stdout, or
# nothing when no issue is ready or on a dry run.
start() {
  local issue title task
  # Loops that start at the same time would pick the same issue, so only one
  # picks and assigns at a time. The lock is shared by every pin.
  mkdir -p "$HOME/.loopfile/ticket"
  exec 9> "$HOME/.loopfile/ticket/pick.lock"
  flock 9
  if ! issue=$(pick); then
    echo "no ready issue" >&2
    return 0
  fi
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
  (cd "$root" && PATH="$pin/bin:$PATH" loopfile "$pin/ticket.loop" -d \
    --input task="$task" --input issue="$issue" --input merge="$merge" --input ci="$ci")
}

runid=$(start)
[ -n "$runid" ] || exit 0
echo "run: $runid"
if [ "$loop" = no ]; then
  echo "follow: PATH=\"$pin/bin:\$PATH\" loopfile tail $runid"
  exit 0
fi

# tail exits 0 only when the run completed, so a failed run stops the loop.
while PATH="$pin/bin:$PATH" loopfile tail "$runid"; do
  runid=$(start)
  [ -n "$runid" ] || exit 0
  echo "run: $runid"
done
echo "run $runid did not complete, stopping" >&2
exit 1
