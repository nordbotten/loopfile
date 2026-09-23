# Loopfile

Loopfile is a small, deterministic runtime for agentic software-engineering workflows. An agent may write a workflow, but once a run starts, Loopfile runs the graph itself with bounded attempts and explicit transitions. No supervisor LLM makes routing choices.

## Language

### Packaging

**Loopfile**:
A packaged workflow: a manifest plus the prompts, schemas, context and other assets it uses.
_Avoid_: Loop (as a noun), package, pipeline

**Manifest**:
The `manifest.yaml` document that declares a Loopfile's workflow.

**Source directory**:
A Loopfile as a directory with `manifest.yaml` at its root.

**Thin `.loop`**:
A `.loop` file that is the manifest itself.

**Packed `.loop`**:
A `.loop` tar archive with `manifest.yaml` at its root plus the Loopfile's assets.

**Remote Loopfile**:
A Loopfile named by its Git host, repository, optional path and optional ref, and fetched at launch. It is not the target repository. `unpack` turns it into a local Loopfile that keeps no link to its source.
_Avoid_: Remote repo, URL source

**Trust list**:
The operator's list of repositories and owners whose Remote Loopfiles launch without asking first. A local Loopfile never needs it.
_Avoid_: Whitelist, allowlist

**Format version**:
The integer that says which version of a file format something follows, such as a manifest or an event log. It is separate from the Loopfile tool's version.
_Avoid_: Schema version, API version

**Upgrade**:
Rewrite a Loopfile's manifest from an older format version to the current one.
_Avoid_: Migrate, convert

### Workflow

**Workflow**:
The explicit graph of steps and routes that a Loopfile declares. It may contain cycles.
_Avoid_: Flow, plan

**Step**:
One node in a workflow.
_Avoid_: Task, stage, node

**Agent step**:
A step that calls a harness once.

**Command step**:
A step that runs a shell command.

**Ralph step**:
A step that calls a harness repeatedly, each time with fresh context.
_Avoid_: Loop step

**Iteration**:
One harness call inside an attempt of a Ralph step. Each iteration starts with fresh context.
_Avoid_: Loop, pass, turn

**Outcome**:
The structured result a step reports, such as `approved` or `changes_requested`. It is separate from the process exit status.
_Avoid_: Result, status

**Route**:
A declared rule that picks the next step from an outcome or exit status.

**Transition**:
One move during a run from a step to the next step or to an end state. A route, a failed attempt or going to the next step in the list can cause it.

**Handoff**:
Data one step puts under a data key for a later step to read through the runtime, not through files or prompt text the steps share.
_Avoid_: Artifact passing

**Data key**:
The name that data is put under. It belongs to the step that puts it. An input belongs to the run.

**Input**:
Text the user gives at launch with `--input <name>=<value>`, for example `--input issue=42`. It is kept under the data key `input.<name>`, and every step can read it. The step ID `input` is reserved. A manifest declares every input it takes with a description. An input with a default is optional, and a run that does not give it uses the default. An input with no default is required. An input that is not declared is a launch error.
_Avoid_: Task, parameter, argument

**Output**:
A data key that a step declares it must put before its attempt ends.
_Avoid_: Artifact, result

**Prompt data**:
Everything a prompt can read when the run owner fills it before a harness call: inputs, handoffs, the value history of each data key, and run facts.

**Run facts**:
The part of prompt data that the runtime writes about the run itself, such as where and when the run started, its limits, the earlier attempts, the current attempt, its iteration and the attempt that sent the run to this step. A run fact is exposed when a prompt author could want it and the runtime already knows it. A step can never write one. `loopfile result <runid> --json` gives some of the run facts, with the same names.

**Placeholder**:
A `{{ <name> }}` marker in a prompt that the run owner replaces with that part of prompt data before each harness call. A block, such as `{{#each <name>}}` to `{{/each}}` or `{{#if <name>}}` to `{{/if}}`, repeats its text for each item of a list or shows it only when the name has a value. Prompts hold no other logic.
_Avoid_: Variable, template, interpolation

**Value history**:
Every value put under one data key, oldest first. A step always reads the newest value. A prompt can read the whole history of any key. A plain placeholder for a key written with `data append` fills as the whole history.

### Execution

**Run**:
One execution of a Loopfile against a target repository, from launch to final outcome.
_Avoid_: Job (kept for a possible future scheduler)

**Loop**:
Running a Loopfile many times, one run after another, with `loopfile loop`. As a noun, the loop is the whole repeat. It has a loop ID of its own and holds the runs it started and its place in the input source. Each run it starts is an ordinary run with its own run ID. As a verb, to loop a Loopfile is to start a loop for it.
_Avoid_: Batch, burn, repeat, series

**Input source**:
Where a loop gets the input set of its next run: a count, a list or a command. A loop has exactly one. A Loopfile with no inputs still loops from a count or a command.
_Avoid_: Queue, feed

**Input set**:
The inputs one run gets, as names and string values. In a loop, the input source and the loop's own `--input` flags make it together, and a name comes from only one of them.
_Avoid_: Row, item, parameters

**Attempt**:
One execution of a step within a run. A step visited again gets a new attempt, and earlier attempts are kept.
_Avoid_: Round

**Interrupt**:
Stop the current attempt of a running run from outside it, with `loopfile interrupt`. The attempt counts toward the step's `maxAttempts`, and the same step gets a new attempt, as after a crash and resume. The run's routes are not used.
_Avoid_: Retry, restart, kill

**Continue**:
Make an ended run go on, with `loopfile continue`. It is the same run, on the same branch and workspace. The step that stopped the run gets a new attempt with the same inputs, as after an interrupt, and the run's limits count again from the continue. A completed run cannot continue. A crashed run resumes instead.
_Avoid_: Retry (a loop's new run for a failed run), restart, rerun

**Materialized Loopfile**:
The fixed copy of a Loopfile that one run owns, made at launch from any input type. It holds only what the Loopfile shipped. A prompt written inline in the manifest becomes a file in a run-owned folder next to it, not inside it. In a loop, the loop makes one Materialized Loopfile when it starts, and each run's Materialized Loopfile is a copy of it.
_Avoid_: Snapshot, copy, extracted package

**Event log**:
The append-only record of a run's state changes and data layer calls. It is the source of truth for the run.
_Avoid_: State file, history

**Run owner**:
The one process that carries out a run's steps and the only one that writes its event log. It runs in the background for every run, attached or detached.

**Loop owner**:
The one process that carries out a loop: it starts each run and is the only writer of the loop's event log. It runs in the background, attached or detached.

**Target folder**:
The folder a run works from: the launch folder in `here` mode; in `isolate`, the Git top level when the launch folder is inside a repository, or the launch folder otherwise. `empty` runs have no Target folder. Run state never lives inside it.
_Avoid_: Target repository

**Workspace**:
Where all steps in a run work, selected by its workspace mode. In `here`, it is the Target folder itself. In `isolate`, it is a Git worktree when Git can make one, otherwise a full copy of the Target folder. In `empty`, it is a new empty folder with no Target files.
_Avoid_: Checkout, sandbox

**Run branch**:
The branch `loopfile/<runid>` for an isolate worktree. It is the run's product and Loopfile never deletes it; `here` and `empty` runs have none.

**Remove**:
Deleting one run's folder and any workspace Loopfile made because someone asked for it. In `here`, only the run folder is deleted. The run branch stays. Loopfile never removes a run on its own.
_Avoid_: Delete, clean, abandon

**Prune**:
Removing, in one command, every run that ended and cannot be resumed, optionally only those that ended longer ago than a given age. A run that cannot be removed safely is skipped.
_Avoid_: Garbage collection, cleanup

**Harness**:
A coding-agent tool that an agent step or Ralph step calls.
_Avoid_: Agent, model, provider

**Harness adapter**:
The code inside Loopfile that lets it call one harness. Harness adapters are built in, not loaded as plugins.
_Avoid_: Plugin, driver, integration

**Executor**:
Where and how a step's processes start, such as a local process. Step kinds are not executors.
_Avoid_: Runner

**Execution context**:
What an attempt gets from the runtime: its run and attempt identity, its workspace, a scratch folder and a way to reach the run owner. It is the same for every step kind.
_Avoid_: Environment, job context

**Step command**:
A command a running step calls to reach the run owner: `result`, `data get` and `data put`. It works only inside an attempt, and its output is agent-first.
_Avoid_: Agent command, tool call

**Operator command**:
A command called from outside a run, such as the launch path, `tail`, `result` or `remove`. It works with no terminal, and its output follows the operator contract (ADR 0011).
_Avoid_: CLI command, client command

**Data store**:
The runtime-owned place where handoffs and step data are kept.

### Observability

**Status projection**:
A compact, machine-readable view of a run's current state. It is derived and is never the source of truth.
_Avoid_: State file

**Activity log**:
An append-only, readable log of one run's progress.
_Avoid_: Job log, transcript

**Monitor**:
The live view attached to a run. It reads the status projection.
_Avoid_: Dashboard, TUI

**Detach**:
Stop watching a run while the run keeps going.
