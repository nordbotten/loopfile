# Observers read two derived files that only the run owner writes

A run has two files for observers next to `events.jsonl`: `status.json`, the status projection, and `activity.log`, the activity log. Only the run owner writes them. `loopfile status --json`, `loopfile list`, `loopfile tail` and the monitor only read them. We picked this so every observer is a plain reader with no special runtime path, and because harness data such as tokens and progress text is not an event (ADR 0003), so observers need a place to find it other than a replay of `events.jsonl`.

## Decisions

- **Location:** `~/.loopfile/runs/<runid>/status.json` and `~/.loopfile/runs/<runid>/activity.log`.
- **One writer:** the run owner writes both files, the same as `events.jsonl`. No other process writes them.
- **Status projection:** one JSON file. The run owner writes a temp file and renames it over the old one, so a reader never sees half a file. It records the last event `seq` it includes and an `updatedAt` time.
- **Derived, not state:** resume never reads `status.json`, and deleting it loses nothing. The "no snapshot" rule of ADR 0003 is about run state and does not apply here. `status.json` never says crashed. A reader shows crashed when the run owner is not alive, as ADR 0003 says.
- **Activity log:** plain text only, one line per message with a time, the attempt ID and short text. `loopfile tail` follows the file, and so does `tail -f`. There is no structured activity feed, because the structured facts are already in `events.jsonl` and the metrics are in `status.json`. The activity log has no format version (ADR 0006).
- **Name style:** every field name in `status.json`, `status --json` and `list --json` is camelCase, the same as the manifest (`formatVersion`, `maxAttempts`). Enum values stay lowercase with underscores, the same as event end reasons such as `attempt_limit`.
- **CLI output from `events.jsonl`:** a command may print lines read from `events.jsonl` as its output, as `loopfile tail --json` does (ADR 0010).
- **Read-only:** no process takes either file as input for a command. Cancel goes to the run owner through the channel decided in #61. Detach happens only in the client and writes nothing.
- **Unknown enum values:** a reader never rejects `status.json` because a field holds a value it does not know, such as an `endReason` a newer tool wrote. It passes the value through as itself (ADR 0006, #196). `endReason` includes `internal_error`, which a run gets when an error escaped the run owner (ADR 0003).
- **Unknown metrics:** every status field is always present. For a harness metric such as tokens, cost, tool count or permission denials, `null` means unknown. A number, including `0`, is a value the harness reported. A harness adapter never estimates a value. Which fields exist is decided in #46. Terminal events also carry the final metrics snapshot for `tail --json`; live harness updates still belong in `status.json`.
- **What the activity log gets:** step start and end, the route taken, the outcome, each agent tool call from the harness (the tool name and a short target, for example `edit src/x.ts`), each data or result command (for example `data get review.md`), and short progress text from the harness.
- **What the activity log never gets:** prompts, file contents, tool arguments beyond the short target, environment values, the attempt secret or raw process output. Raw output stays in the attempt folder, and a log line can point to it.
- **Filtering:** the harness adapter in the run owner filters the text before it is written. Each message, including a `bash` command, is cut to one line of about 200 characters, with no environment values.

## Considered Options

- **No status file, readers replay `events.jsonl`:** harness metrics and progress text are not events, so every reader would also have to parse the activity log.
- **Structured `activity.jsonl`:** a second structured feed that repeats `events.jsonl` and `status.json`, and `tail -f` would no longer be readable.
- **Leave out unknown metrics:** every consumer would need a check that a field is present, and a missing field would mean the same as `null`.
- **Only lifecycle lines and our commands in the log, no agent tool calls:** `tail` shows nothing while an agent works for many minutes.
- **Observers write markers such as cancel requests into the files:** breaks the one-writer rule and makes an observer file a second control path.
