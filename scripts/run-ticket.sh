#!/usr/bin/env bash
# Pick one ready issue and start loops/ticket on it with a pinned loopfile.
#
#   scripts/run-ticket.sh pin        build and copy loopfile to $LOOPFILE_PIN
#   scripts/run-ticket.sh [--merge]  pick the lowest ready issue and start a run
#   scripts/run-ticket.sh --loop [--merge]
#                                    follow each run with tail, then start the
#                                    next; stop when a run does not complete or
#                                    no issue is ready
#   scripts/run-ticket.sh --dry-run  only print the issue it would pick
#
# The pinned copy is on PATH only for the run, so the run owner, the steps and
# the agents all use it. A merged change cannot break the next run.
set -euo pipefail
shopt -s inherit_errexit  # keep set -e inside $(start)

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
pin=${LOOPFILE_PIN:-$HOME/.loopfile/pinned}

if [ "${1:-}" = pin ]; then
  (cd "$root" && npm run build)
  rm -rf "$pin"
  mkdir -p "$pin/bin"
  cp -r "$root/dist" "$root/package.json" "$pin/"
  (cd "$pin" && npm install --omit=dev --no-package-lock --ignore-scripts --no-audit --no-fund)
  chmod +x "$pin/dist/cli.js"
  ln -s ../dist/cli.js "$pin/bin/loopfile"
  echo "pinned: $pin ($(git -C "$root" rev-parse --short HEAD))"
  exit 0
fi

merge=no
dry_run=no
loop=no
for arg in "$@"; do
  case "$arg" in
    --merge) merge=yes ;;
    --dry-run) dry_run=yes ;;
    --loop) loop=yes ;;
    *) echo "usage: $0 [pin | --merge | --loop | --dry-run]" >&2; exit 2 ;;
  esac
done

# The ready issue with the lowest number: no assignee, no open linked PR and
# every issue in its "## Blocked by" section closed.
pick() {
  local n body blocker
  for n in $(gh issue list --label ready-for-agent --state open --search no:assignee \
    --json number --limit 200 -q '.[].number' | sort -n); do
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

[ "$dry_run" = yes ] || [ -x "$pin/bin/loopfile" ] || { echo "no pinned loopfile, run: $0 pin" >&2; exit 2; }

# Picks one issue and starts a run on it. Prints the run ID on stdout, or
# nothing when no issue is ready or on a dry run.
start() {
  local issue title task
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
  task="#$issue $title

$(gh issue view "$issue" --json body -q .body)"
  (cd "$root" && PATH="$pin/bin:$PATH" loopfile "$root/loops/ticket" -d \
    --input task="$task" --input issue="$issue" --input merge="$merge")
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
