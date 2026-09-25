# A Remote Loopfile is fetched with git for each launch and runs only after a trust check

A user can launch a Loopfile straight from a Git host: `loopfile github:owner/repo[/path][@ref]` or a `git+https://` URL. A Loopfile can run any shell command and any agent as the user, so a Remote Loopfile runs only when the user trusts where it comes from. We picked trust by repository or owner name, asked once in a prompt and kept in a file the user edits by hand, because this is what most tools do and it keeps the rule simple. After trust, a Remote Loopfile runs the same as a local one. The map is nordbotten/loopfile#4, and every bare ticket number here is in nordbotten/loopfile. The detail of each decision is in the ticket it cites. This ADR records what they are and how they fit.

## Decisions

- **Source grammar (#5):** GitHub first. A bare `owner/repo[/path][@ref]`, `github:owner/repo[/path][@ref]` and github.com browser links (`/tree/<ref>/<path>`, `/blob/<ref>/<file>.loop`). Every other host uses pip's form, `git+https://` or `git+ssh://host/org/repo[.git][@ref][#subdirectory=path]`. A bare `owner/repo` is local when that path exists. `github:`, `https://github.com/` and `git+` are always remote. The ref is the text after the last `@`: a branch, a tag, a full or short SHA, or the default branch when there is none. The path names a source directory or a `.loop`, loaded as a local path is. `git+http://`, `git+file://` and the scp form are refused with an error that names the form to use.
- **Fetch (#8, loopfile-archive#299):** `git ls-remote` turns the ref into a full SHA. Then a shallow, sparse, `blob:none` clone of the Loopfile path at that SHA, with a clone of full history for hosts that refuse a fetch by SHA and for a short SHA. No submodules. LFS files stay pointers. The fetch runs no code from the repository.
- **No cache (#8):** each launch fetches into a new `mkdtemp` folder in the OS temp dir. The launcher deletes it after the run owner answers "ready", because the run owner has its own copy by then (ADR 0008), and on any failure. Resume uses the run's copy and never fetches.
- **Git auth and errors (#10):** git may prompt for a password, a passphrase or a host key when there is a terminal, also with `-d`. With no terminal, `GIT_TERMINAL_PROMPT=0` makes git fail at once. The codes are `git_missing` and `fetch_failed` (ADR 0011). A ref or path that is not found is `bad_argument`. All exit 2. Git's stderr follows the `error:` line.
- **Trust list (#6):** `$LOOPFILE_HOME/trust.yaml` holds a `formatVersion` and two lists, `repos` and `owners` (ADR 0006). The key is lowercase `host/owner/repo`, with no scheme, user part, `.git`, path or ref, so https and ssh share trust. An owner entry matches whole path segments. Trust is by name only: a new commit does not ask again. The user edits the file by hand. A file that cannot be read refuses every remote launch and is never overwritten.
- **Trust prompt (#7):** a red-on-black DANGER banner, then a summary from the manifest: the source, the full SHA, each step's kind, harness, model and effort (a field expression shows as written, and a step with a profile shows `profile` as written), each profile once (ADR 0015), the first line of each `run`, and full agent `args`. Then an `unpack` line to read the full text, then a select: trust the repo, trust the owner, or Deny, which is the default and writes nothing.
- **No terminal (#11, loopfile-archive#298):** a local source never asks. For a remote one, the prompt shows only when stdin and stderr are both terminals, and it prints on stderr. `--trust` trusts one launch and writes nothing. It does nothing on a local or trusted source, so a script can always pass it. There is no environment variable. With no terminal and no trust, the launch refuses with `untrusted`, exit 2. `-d` asks before the run owner starts.
- **Record (#9):** an optional `remote` field on `run.created`, copied to `status.json`: host, lowercase `owner/repo`, path, ref and full SHA, with no URL user part. `loopfileName` is the last segment of the path, or the repo name. `status`, `result` and `check` print a `remote:` line. A loop pins the SHA at loop start and asks for trust once.
- **`check` and `unpack` (#12, #13):** they fetch the same way, but they never ask for trust and never read `trust.yaml`, so the prompt's `unpack` line always works. `unpack <remote> [dest]` makes a Remote Loopfile ours: a local source directory with no link to its origin, which never asks for trust. `upgrade` refuses a Remote Loopfile because it writes to the source.
- **No guard after trust (#107):** a trusted Remote Loopfile runs with no extra limits, because a command step can already run any code. Trust does not pass to a nested `loopfile github:…` in a step. That step has no terminal, so it refuses with `untrusted` unless the inner repository is trusted or the step passes `--trust`, which the prompt shows.

## Considered Options

- **Trust by content, asking again on each new SHA, as direnv does:** a Loopfile on a branch would ask on every push, and users learn to press yes without reading (#6, loopfile-archive#300).
- **No prompt, as `gh extension install` does:** the user never sees that a repository can run code as them (loopfile-archive#300).
- **A cache keyed by SHA:** `ls-remote` needs the network anyway, and a cache needs its own cleanup (#8).
- **A `LOOPFILE_TRUST` environment variable:** steps inherit it, so every nested Remote Loopfile launch would be trusted without a word (#11).
- **Reuse `no_terminal` for the refusal:** the fix is to give trust, not to find a terminal (#11).
- **A `loopfile trust` command:** the file is short and plain. Add a command when hand edits are not enough (#6).
- **A `clone` command with an origin note:** Git's `clone` keeps a link and this copy has none. A note changes the format and invites an "update from upstream" feature (#13).
- **Extra agent limits on a Remote Loopfile, or red marks on risky args:** a command step already runs any code, and a mark on one flag suggests the rest is safe (#107).
- **A registry, or an HTTPS URL to a `.loop` with no Git:** out of scope for this map (#4).

## Consequences

- Git on PATH is needed for Remote Loopfiles only. Local sources work without it.
- A new commit on a trusted repository runs with no question. The recorded SHA shows after the fact what ran.
- A company can ship `trust.yaml` with its dotfiles. An org-wide trust list can be added later with no break to the format.
- A leftover temp folder from a killed launcher stays until the OS cleans the temp dir. `prune` does not touch it.
