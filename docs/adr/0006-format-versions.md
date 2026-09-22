# Four formats carry an integer format version, checked before launch

Every manifest declares a format version from the first release. Three other formats get their own version too: events, the execution context protocol and the `--json` outputs. The tool version is separate from all of them. A version is one integer that goes up only when a change breaks old files. We picked this so a future breaking change can be rejected or upgraded, not guessed. We picked strict rejection so a user never thinks a workflow is running as written when the tool actually ignored part of it.

## Decisions

- **Required marker:** every manifest has a top-level format version field. A manifest without one fails to load. The field name is decided in #02.
- **One marker for all input types:** source directories, thin `.loop` files and packed `.loop` files all carry the version in `manifest.yaml`. The packed archive layout is part of the manifest format. It has no version of its own.
- **Integer:** `1`, `2`, and so on. Additions do not bump it, because unknown fields are rejected (see below).
- **A new value in a closed list is an addition:** adding a value to an enumeration in the event format or a `--json` output does not bump the version. A version says how to parse a file, and these values are only shown or branched on, never used to decide how to read the rest. Every reader passes an unknown value through as itself and never rejects the file over it (#196).
- **An added event field is an addition:** the optional `metrics` field on `attempt.ended` is an addition, so the event format version stays `1`.
- **Versioned formats:** the manifest format, the event format (recorded in `run.created`, ADR 0003), the execution context protocol (the `LOOPFILE_*` variables and the data and result commands, ADR 0005), and the `status --json`, `list --json` and `result --json` output (fields owned by #46 and #195). The attempt folder layout falls under the event format. The activity log and harness adapters have no version.
- **Newer or unknown:** a manifest version newer than the tool knows is rejected with an "upgrade loopfile" error. An unknown field in a known version is rejected.
- **Older manifest:** Loopfile shows the diff and asks `Manifest is outdated. Upgrade? [Y/n]`. Yes rewrites the source in place and then starts the run. A source directory or thin `.loop` gets a new `manifest.yaml`, and a packed `.loop` is repacked. The runtime never sees an old format (ADR 0002).
- **No terminal:** when no person can answer, the launch refuses with the AXI failure block, code `manifest_outdated` and exit 2. Nothing runs. `help:` names `loopfile upgrade <source>`, which does the same rewrite without a run (#200).
- **Stdin:** a manifest read from stdin (`loopfile -`) never has a person to ask and no file to rewrite, so it always gets the no-terminal refusal. Its `help:` names `loopfile upgrade - < old.yaml > new.yaml`. `loopfile upgrade -` reads a manifest on stdin and writes the upgraded manifest on stdout, with the AXI block on stderr. A manifest that is already current comes back unchanged with exit 0 (#200).
- **Check:** `loopfile check <source>` fails on an older manifest for every source kind, with one error on `formatVersion`, because launch without a terminal refuses it (#200).
- **Every upgrade step is kept:** the upgrade path has a step from every older version to the next one, forever, so no manifest is too old to upgrade. A breaking change that cannot be mapped fails inside its step with an error on the field the user must change by hand (#200).
- **Before launch:** validation, the version check and the upgrade prompt always run in the foreground before the run starts, with or without `-d`.
- **Resume:** `run.created` records a digest of the built model. Resume rebuilds the model from the materialized Loopfile and continues only when the digest matches and the event format version is still readable. Otherwise it stops with an error that shows both digests. No flag skips this check in v1.

## Considered Options

- **Optional marker, missing means 1:** later tools would have to guess what an unmarked file means.
- **Separate version file in packed archives:** a second marker that can disagree with the manifest.
- **Semver:** a minor number that nothing checks.
- **Ignore unknown fields:** an old tool would run a workflow without the parts it does not know, and the user would not be told.
- **Convert older manifests silently in the loader:** the user never sees what changed, and it happens again on every run.
- **Convert only the run's materialized Loopfile:** the source stays old and the prompt returns on every run.
- **Upgrade without asking when no terminal is present:** agents and CI would rewrite files in a repository with no review.
- **Upgrade a stdin manifest in memory and run it:** the agent or template that wrote the old manifest stays wrong, and every run converts again with nobody looking (#200).
- **Drop old upgrade steps to keep the package small:** a manifest would become too old for the tool, with a separate error and no way forward but an older release. The steps are small (#200).
- **Refuse resume on any tool version change:** blocks patch releases that do not change the model.
- **Always resume:** a new loader could change the workflow in the middle of a run.

## Consequences

- Each loader keeps an upgrade path from every older manifest version, forever. A test checks that every version below the current one has a step. `loopfile upgrade` and the prompt share it.
- The model must serialize in a stable way so its digest is repeatable (ADR 0002 already makes it plain JSON-serializable data).
- A step reads the execution context protocol version from `LOOPFILE_PROTOCOL_VERSION` (#84, ADR 0005).
