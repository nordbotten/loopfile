# Every source file has a zone, and CORE stays pure

Loopfile's product is that a run is deterministic: once a run starts, the graph,
the routes and the bounded attempts decide everything, and no supervisor LLM
makes routing choices. That claim is only as good as our ability to test routing
and transitions without a disk, a process or a network. So every tracked file
under `src/` is classified into one zone, and the zone named `CORE` may not
import the filesystem, processes, the host, the network or a harness SDK. A
`CORE` file that needs one of those is telling us it belongs under
`src/adapters/`.

The zone map is one module, `quality/quality-zones.mjs`, that every quality tool
reads. We picked one map rather than a rule per tool because the alternative
drifts silently: a coverage glob and an import rule that disagree about what
counts as domain code will both pass while the boundary rots between them. We
checked this against firstmate's `samle`, where the same single-map design is
what keeps a much larger stack coherent.

We deliberately took about half of that stack. The parts left out are recorded
in `quality/QUALITY.md` so a future reader does not mistake absence for
oversight.

## Decisions

- **Three zones and a test exclusion:** `CORE` is pure logic, `BOUNDARY` is the
  explicit side-effect edge, `EXEMPT` is the CLI entry point, and `TESTS` is an
  exclusion rather than a measured zone.
- **One map, read by every tool:** `quality-zones.mjs` answers what a file is.
  No other tool decides it, and no tool carries its own source glob.
- **CORE is the default:** a flat `src/*.ts` with no entry in the map is `CORE`,
  the strictest zone. A new file is pure until it proves otherwise, and one that
  cannot honour the import rule must say why in the map or move to
  `src/adapters/`. Only a file in an unknown top-level directory under `src/`
  fails as unclassified, because a new directory is a decision.
- **What CORE may not import:** the filesystem, `node:child_process`,
  `node:os`, the network modules, `node:worker_threads`, and harness SDKs.
  Harness adapters are built in (ADR 0004), so an SDK import in `CORE` is
  always a zone slip rather than a legitimate shortcut.
- **Files come from `git ls-files`:** never from a glob. Agents run in git
  worktrees under `.claude/worktrees/`, excluded locally through
  `.git/info/exclude`, which git honours and a glob does not. Globbing reads
  another branch's code as if it were this one's. `biome.json` excludes the
  same directory for the same reason. The listing includes written-but-unstaged
  files, so a new file is checked before it is committed, not after.
- **Suppressions have no allowlist:** no `@ts-expect-error`, `biome-ignore`,
  coverage ignore, or skipped, focused or todo test under `src/`. A suppression
  disables the measurement the other checks depend on, so grandfathering one is
  never the right trade.
- **The numbers live outside this ADR:** coverage, CRAP and mutation bars belong
  in `quality/quality-ratchet.json` and `quality/QUALITY.md`, so tightening a
  bar never amends a decision record.
- **The checks' own logic is tested:** `quality/quality-tools.test.mjs` covers
  zone placement, the forbidden imports and the suppression patterns against
  text rather than the working tree, so a green repository cannot hide a check
  that never fires.

## Considered Options

- **A rule per tool, no shared map:** each tool carries its own source glob.
  They drift, and two tools disagreeing about what is domain code both pass.
- **Fail every unclassified file, as `samle` does:** correct for a codebase with
  a settled directory shape, but here it blocks anyone adding a flat `src/*.ts`
  on editing the map first, for no gain over defaulting to the strictest zone.
- **Glob the source tree:** simpler to write, and wrong in this repository the
  moment an agent has a live worktree.
- **A `pre-push` hook to enforce the gate:** gets bypassed with `--no-verify`
  the first time it is inconvenient, invisibly. A stated convention that is
  known to be unenforced is more honest.
- **Complexity budgets through ESLint:** a second general linter beside Biome,
  to measure something CRAP already reaches from a different direction.
- **Landing the bars at the same time:** the numbers have to be measured against
  a codebase that exists. The constraints cost nothing to satisfy today and are
  expensive to retrofit, so they land first and alone.

## Consequences

- A new top-level directory under `src/` fails the gate until it is classified.
  That is the intended prompt for a conversation, not an obstacle to route
  around.
- `src/adapters/input.ts` is `BOUNDARY` because it stats and reads the launch
  input path. If its pure part — the gzip magic check and the UTF-8 test — is
  ever wanted under a `CORE` bar, it splits into a classifier and a reader.
- At full coverage a CRAP score equals the function's complexity, so the ceiling
  of 10 is also a complexity cap of 10 for fully tested code. That is the
  intended reading. It is the one place a complexity budget enters, and it
  enters through a measure that rewards tests rather than a separate linter.
- The run owner (ADR 0008) is the hard case ahead: pure decisions wrapped around
  processes and an append-only log. It has to land as a `CORE` reducer with a
  `BOUNDARY` driver, or the `CORE` bars stop meaning anything the day it lands.
- Mutation runs the whole suite once per mutant, because `node --test` has no
  first-party Stryker runner. That is affordable now and will not stay so
  forever. When it stops being affordable, scope the run; do not lower the bar.
- CI runs the gate on the repository's two self-hosted Linux runners. The
  workflow creates no branch protection, so a red gate reports rather than
  blocks a merge.
