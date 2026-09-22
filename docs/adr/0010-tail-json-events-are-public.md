# Run events are a public output of `tail --json`

`loopfile tail <runid> --json` prints each line of the run's `events.jsonl` as it is, one JSON object per line, and stops after the end event (#186). A script reads these lines to follow a run. We picked the event lines over a new shape because they already hold every structured fact about a run (ADR 0003), and a second feed would repeat them (ADR 0007).

## Decisions

- **Loop output:** `loopfile tail <loopid> --json` also prints the loop event types and fields from the loop's `events.jsonl`, one JSON object per line, together with each child run's events. A script may depend on both feeds.
- **Public output:** the run event types and their fields are a public output of `tail --json`. A script may depend on them.
- **Versioned by the event format version:** the output has no version of its own. Run events use the event format version that `run.created` records; loop events use the version that `loop.created` records (ADR 0006). A change to an event's name or to its fields that breaks a reader needs a bump of the relevant event format version.
- **As written:** `tail --json` prints each line as the run or loop owner wrote it. It does not map events to a new shape, add fields or leave fields out.

## Considered Options

- **A new JSON shape for `tail --json`:** a second format to keep in step with the events, with its own version.
- **A new `activity.jsonl` file:** ADR 0007 already rejects a second structured feed.
