# Remote Loopfiles

A Remote Loopfile comes from a Git repository. Loopfile fetches it with Git for
each launch. It does not run repository code during the fetch.

## Sources

These forms select GitHub:

- `owner/repo[/path][@ref]` is the bare form.
- `github:owner/repo[/path][@ref]` always selects a remote source.
- A GitHub browser link can name a repository, a `/tree/<ref>/<path>` folder,
  or a `/blob/<ref>/<file.loop>` file.

For other Git hosts, use `git+https://host/org/repo[.git][@ref][#subdirectory=path]`
or the same form with `git+ssh://`:

```sh remote
loopfile check acme/loops/review@main
loopfile check github:acme/loops/review@main
loopfile check https://github.com/acme/loops
loopfile check https://github.com/acme/loops/tree/main/review
loopfile check https://github.com/acme/loops/blob/main/review.loop
loopfile check git+https://git.example.test/acme/loops@main#subdirectory=review
loopfile check git+ssh://git.example.test/acme/loops@main#subdirectory=review
loopfile check acme/loops/review
loopfile check ./acme/loops/review
```

The examples use a GitHub-shaped fixture. The last two commands use a local
folder in that fixture. If a bare source matches an existing local path, the
local path wins. Prefix it with `./` to force a local path. A valid `github:`
source, a browser link, or a `git+` source is remote.

`git+http://`, `git+file://`, and scp-style sources such as
`user@host:org/repo` are refused. Use `git+https://` or `git+ssh://` instead.
Plain browser links to GitLab and Bitbucket are refused too.

## Refs and paths

In bare, `github:` and `git+` sources, a ref follows the last `@`. Browser
links put it after `/tree/` or `/blob/`. A ref can be a branch, tag, full or
short commit SHA. Without one, Loopfile uses the repository's default branch.

A path selects a source directory or a `.loop` file. In a Git VCS URL, write a
directory as `#subdirectory=path`. GitHub `/tree/` links select directories;
`/blob/` links must select a `.loop` file.

## Trust

A Remote Loopfile can run any shell command and any agent in your workspace,
as you. An untrusted one runs only after approval. When stdin and stderr are
terminals, Loopfile shows a danger warning, the source and full commit SHA, and
a summary of every step. It shows each step's kind. For command steps, it shows
the first line of `run`. For agent and Ralph steps, it shows the harness and
model. It also shows full `args` when set. Loopfile asks before starting the
run, even with `-d`. The choices are:

- **Trust repo** saves this repository for future launches.
- **Trust everything from owner** saves this host and owner for future launches.
- **Deny** is the default. It writes nothing and stops the launch.

The list is `$LOOPFILE_HOME/trust.yaml` (`~/.loopfile/trust.yaml` by default):

```yaml trust
formatVersion: 1
repos:
  - github.com/acme/loops
owners:
  - git.example.test/team
```

`formatVersion` must be `1`. `repos` and `owners` are lists of strings; either
list may be omitted. A repo entry is `host/owner/repo`. An owner entry is
`host/owner`. Matching ignores case. An owner matches whole path segments, so
`github.com/acme` matches `github.com/acme/loops`, not
`github.com/acme-tools/loops`. Schemes, credentials, `.git`, refs and source
paths do not belong in entries. Trust is by name, not commit; a trusted repo
stays trusted when its contents change.

You can edit the file by hand. If it cannot be read, or its YAML or format is
invalid, every remote launch is refused with `untrusted`. Loopfile does not
replace a broken file. Fix or remove it. `check` and `unpack` do not read the trust file.

## Scripts and nested launches

`--trust` approves one launch. It does not change `trust.yaml`. It is useful in
scripts or CI when the source was approved in advance:

```sh remote
loopfile github:acme/loops/review@main --trust --workspace empty
```

With no terminal, an untrusted launch fails with `untrusted` unless it has
`--trust`. Git authentication also needs non-interactive credentials in CI.
`--trust` does not help if Git cannot fetch the repository.

A step has no terminal. Trust is not passed to a nested Loopfile launch. A
nested remote launch therefore needs a matching trust entry or its own
`--trust`. Use `--trust` there only when the user asked for that source.

## Inspecting and copying

`check` fetches and validates a Remote Loopfile without running it or asking for
trust. `unpack` copies it into a local source directory but does not validate
the manifest. The copy has no link to the original and needs no trust. Read the
copy before you decide to trust its source.

```sh remote
loopfile check github:acme/loops/review@main
loopfile unpack github:acme/loops/review@main ./review-copy
```

`check` prints a `remote:` line with the full commit SHA. `unpack` prints the
source and SHA it copied.

## Run record and errors

A remote run records a `remote` value on its `run.created` event and in
`status.json`. It has the host, lowercase `owner/repo`, optional path and ref,
and full commit SHA. It has no URL credentials. `loopfile status`,
`loopfile result`, and `loopfile check` show a `remote:` line.

Remote failures use these error codes. Each exits with code `2`:

- `untrusted`: approval is missing, was denied, or `trust.yaml` is broken.
- `git_missing`: Git is not on `PATH`.
- `fetch_failed`: Git could not fetch the repository. Check its name, network
  access and credentials.

Git is needed only for remote sources. Local Loopfiles work without Git.

There is no cache. Each remote operation fetches the repository again. The
launcher normally removes its temporary fetch folder. If the launcher is
killed, the folder stays until the operating system cleans its temp directory.
