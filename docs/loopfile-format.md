# The Loopfile format

This page describes the v1 Loopfile format: how a Loopfile is stored, packed and
upgraded. It matches the code that is built today.

A **Loopfile** is a manifest plus the prompts and other files it uses. It has
three forms. All three carry the same `manifest.yaml`.

| Form | What it is |
| --- | --- |
| Source directory | A directory with `manifest.yaml` at its root. |
| Thin `.loop` | One text file. The file is the manifest. |
| Packed `.loop` | A gzip-compressed tar archive with `manifest.yaml` at its root. |

`loopfile` tells the forms apart by content, not by file name. A file that
starts with the gzip bytes `1f 8b` is a packed `.loop`. Any other file must be
UTF-8 text with no NUL byte, and it is a thin `.loop`. An empty file is an error.

The fields of the manifest and the workflow model are on the page
[The v1 manifest](manifest-v1.md). This page does not repeat them.

## Source directory

A source directory holds `manifest.yaml` at its root and every file the manifest
refers to. Every file in the directory belongs to the Loopfile, except `.git/`,
which `loopfile pack` leaves out.

```
my-loopfile/
├── manifest.yaml
└── prompts/
    └── build.md
```

```yaml source
formatVersion: 1
steps:
  - id: build
    kind: agent
    harness: claude
    promptFile: prompts/build.md
    on:
      done: $success
```

Loading a directory fails with `no manifest.yaml at the root of <directory>` when
the manifest is missing. A run does not use the directory itself. It makes a
materialized Loopfile from it at launch, so a later edit of the source never
changes a run.

## `manifest.yaml`

`manifest.yaml` is a YAML document. These are its top-level fields.

| Field | Required | Meaning |
| --- | --- | --- |
| `formatVersion` | yes | The integer `1`. |
| `steps` | yes | The ordered list of steps. |
| `inputs` | no | The inputs the Loopfile takes. |
| `maxTransitions` | no | A limit on transitions. |
| `runTimeout` | no | A limit on the run's time. |

Every other top-level field is a validation error. This applies inside the
manifest too: an unknown field is never ignored. See
[The v1 manifest](manifest-v1.md) for what each field means.

`formatVersion` is required in every form, and it is the only version marker
([ADR 0006](adr/0006-format-versions.md)). The version is checked as follows.

- A missing `formatVersion`, or one that is not an integer, is a validation
  error: `formatVersion is required and must be an integer`.
- A higher number than the tool knows is a validation error that ends with
  `upgrade loopfile`. Install a newer Loopfile tool.
- A lower number is not a validation error. It goes to
  [the upgrade prompt](#upgrade).

A validation error shows the field path and, when it can find it, the line in
the manifest.

## Thin `.loop`

A thin `.loop` is one file, and the file is the manifest. The same thin
manifest can be read from stdin with `loopfile -` or `loopfile check -`. It has
no files next to it, so it must give every prompt inline with `prompt`.
`promptFile` is a validation error in a thin `.loop`:
`a thin .loop has no files, so it cannot use promptFile: use a source directory or a packed .loop`.

```yaml thin
formatVersion: 1
steps:
  - id: build
    kind: agent
    harness: claude
    prompt: Build what the issue asks for, then report the outcome.
    on:
      done: $success
```

## Packed `.loop`

A packed `.loop` is a tar archive compressed with gzip. It holds `manifest.yaml`
at its root and the other files of the Loopfile, in the same layout as the source
directory. It has no version of its own: the version is in `manifest.yaml`.

### Make and open one

`loopfile pack <directory> [-o <path>] [--force]` writes a packed `.loop`. Pack
a Loopfile to share it as one file. You do not need to pack it to keep a run
the same: every run already works from its own copy.

- The directory is loaded first. A manifest that is not valid, or is older than
  this tool reads, stops the command and no file is written. For an older
  manifest, run `loopfile upgrade` first.
- The output is `<directory name>.loop` in the current directory, or the path
  given with `-o`. If the file exists, the command stops unless you give
  `--force`.
- The command prints the path of the file it wrote.

`loopfile unpack <file.loop|remote> [<destination>]` writes a local source directory.

- The destination is the input name without `.loop`, or the remote Loopfile name,
  unless you give a path. It must not exist, or it must be an empty directory.
- A packed `.loop` is extracted with the safety rules below. A thin `.loop`
  becomes a directory that holds `manifest.yaml`. A remote folder is copied
  without its root `.git` folder.
- A remote copy keeps no link to its origin and never needs trust. It prints the
  source and commit it copied.
- `unpack` does not validate the manifest, so you can unpack an invalid or older
  Loopfile and then fix it. If it fails, it leaves nothing behind.

### Archive safety rules

A run, `pack`, `unpack` and `upgrade` all read a packed `.loop` with the same
strict rules. The headers of the archive are checked first. One unsafe entry
fails the whole load, and nothing is skipped.

- Only files and directories are allowed. A symbolic link, hard link, device or
  any other entry is an error: `<type> entry <path> is not allowed`.
- An entry path must be relative. An absolute path, or a path with a backslash,
  is an error: `entry <path> is not a relative path`.
- An entry path may not have a `..` part: `entry <path> leaves the root`.
- The files may not add up to more than 100 MB (`104857600` bytes) when
  extracted: `more than 100 MB when extracted`.
- `manifest.yaml` must be a file at the root of the archive:
  `no manifest.yaml at the root of <file>`.

An error names the file, for example `<file> is not safe to load: <reason>`.

## Path resolution

A path in a manifest is resolved against the root of the Loopfile, which is the
folder that holds `manifest.yaml`. The only path field in v1 is `promptFile`.

- The path is relative to the root, not to the manifest's own folder or to the
  place where you run `loopfile`.
- An absolute path is a validation error: `promptFile must be relative, not
  absolute`.
- A path that leaves the Loopfile is a validation error: `promptFile must stay
  inside the Loopfile`. A `..` part is allowed only when the path still ends up
  inside, so `prompts/../prompts/build.md` is fine and `../build.md` is not.
- A file that is not in the Loopfile is a validation error:
  ``promptFile `<path>` is not in the Loopfile``.
- A symbolic link in a source directory must point to a place inside the
  directory. Otherwise the load fails with
  `symbolic link points outside the directory: <path>`. The materialized Loopfile follows
  links, so it holds the files they point to. A packed `.loop` cannot hold a link
  at all.

A prompt written inline with `prompt` is not a path. The run keeps it in a
run-owned folder next to the materialized Loopfile, not inside it.

## Deterministic packing

`loopfile pack` writes the same bytes for the same files. Packing a directory
twice gives two identical archives, on any machine. `pack` normalizes these
things.

- **Order.** Entries are sorted by byte value of the path, and `manifest.yaml` is
  always first.
- **Names.** Paths use `/`. The archive has file entries only and no directory
  entries. `.git/` is left out.
- **Time.** Every modification time is zero (1 January 1970).
- **Owner.** No user or group is recorded.
- **Mode.** A file is `0644`, or `0755` when its owner may execute it. Other
  mode bits are dropped.
- **Links.** A link in the directory is followed, and the archive holds the file
  it points to.
- **Compression.** gzip.

The archive is written to a temporary file next to the target and renamed into
place, so a failure never leaves half an archive.

## Upgrade

**Upgrade** rewrites a Loopfile's manifest from an older format version to the
current one, which is `1` today. The upgrade table keeps a step for every older
format version as new versions are added.

Two things start an upgrade.

- **The prompt.** Before a run starts, `loopfile` checks the format version. For
  an older manifest on a terminal, it shows the diff and asks
  `Manifest is outdated. Upgrade? [Y/n]`. Yes (or an empty answer) rewrites the
  Loopfile in place and then starts the run. No stops the run and changes
  nothing: `Upgrade declined. Nothing changed.` When no person can answer, it
  stops with the operator failure block: `code: manifest_outdated`, exit 2, and
  `help: loopfile upgrade <source>`. For stdin, the help is
  `loopfile upgrade - < old.yaml > new.yaml`. The check runs in the foreground,
  with or without `-d`.
- **The command.** `loopfile upgrade <source>` does the same rewrite and never
  asks. It prints the diff and then `Upgraded <source> from formatVersion <n> to
  <current>.`

`<source>` is a source directory, a thin `.loop` or a packed `.loop`.

- A source directory or a thin `.loop` gets a new `manifest.yaml`.
- A packed `.loop` is unpacked, its manifest is rewritten, and the archive is
  packed again with the [rules above](#deterministic-packing).
- The upgraded manifest is validated before anything is written. If it is not
  valid, the command stops and the source does not change.
- The rewrite goes to `<target>.upgrade.tmp` and is renamed over the target, so a
  failure never leaves half a manifest. The file mode is kept.
- The upgrade edits the YAML in place, so comments and key order stay and the
  diff shows only what changed.
- A manifest at the current version is loaded like a normal load. If it is
  valid, the command prints `Manifest is already at formatVersion 1. Nothing
  changed.` and exits 0. Otherwise it shows the validation error.
- The upgrade table keeps a step from every older format version to the next,
  so every older manifest has a path to the current format.

The command exits 0 on success, 1 on a failure and 2 when you give it the wrong
arguments (`Usage: loopfile upgrade <source>`).
