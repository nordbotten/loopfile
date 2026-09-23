# v1 has internal harness adapters, not plugins

v1 loads no third-party code. There is no plugin API. Harnesses are added as harness adapters: built-in TypeScript code behind an internal interface that can change in any release. We picked this because nobody writes plugins yet, and a public API would lock in guesses. The adapter interface is still kept small and the same for each harness, so a new harness is easy to add now and plugins can be built on it later. We checked this against firstmate, where each harness is a `case` branch copied across many scripts and adding one means editing all of them.

## Decisions

- **No dynamic plugins:** v1 never loads code named in a manifest or found on disk. The internal interfaces are not part of the npm package's public API.
- **Interfaces:** only the harness adapter and the executor are interfaces. The workspace and the data store are plain modules with a small set of functions. Each gets an interface when a second version exists. This changes the agreed state, which said all four sit behind replaceable interfaces.
- **Executor:** the executor decides where and how a step's processes start. In v1 that is a local process. Step kinds (agent, command, Ralph) are normal runtime code, not executors.
- **What a harness adapter does:** it gets the execution context (#58) and the filled prompt text. It describes the harness call (command, arguments, stdin, wiring files) and reads the harness output; the runtime starts the process through the executor. It sends activity (tool calls, tokens, progress text) to the runtime.
- **What a harness adapter never does:** decide the outcome, write the event log, pick routes, read the manifest or start processes itself.
- **Outcome:** the agent reports it through Loopfile's data and result commands, the same way for every step kind. Adapters never parse harness output to find it.
- **Registry:** one fixed table in the code maps a harness name to its adapter. The loader rejects a harness name that is not in the table. Plugins, if they come, add rows to this table.
- **Harness wiring files:** hook or settings files an adapter needs are written into its attempt folder and passed to the harness with flags or environment variables. They are never written into the workspace.
- **No terminal emulation:** v1 supports only harnesses that run without a person at the terminal. The executor starts a process with plain input and output pipes and gives it no pseudo-terminal.
- **Cancel:** the executor stops the whole process group, first with TERM and then with KILL after a time limit. Adapters have no cancel code.
- **Tests:** a scripted fake harness adapter lives in the test code only. It is the second adapter, so the interface is not shaped around one real harness.
- **Unsupported harnesses:** users call their CLI from a command step. v1 has no "custom harness" setting.

## Considered Options

- **Public dynamic plugin API in v1:** each later change breaks outside code, and there are no outside users to design for.
- **Interfaces for all four parts:** workspace and data store have only one version each, so the interfaces would only guess at the future.
- **Adapter returns the outcome:** each adapter would need its own output parsing, and agent steps would route differently from command steps.
- **Hook files in the workspace (as firstmate does):** would make run files part of the workspace, where the agent can change or commit them.
- **Pseudo-terminal support in the executor:** needed only for harnesses that must be typed into (Kimi and Rovo in firstmate). It makes the executor, and a later Docker executor, much larger.
- **Per-adapter stop step:** harnesses that run without a terminal stop on a signal.

## Consequences

- A harness that can only read hooks from the worktree, or that has no mode without a terminal, cannot be supported in v1 without revisiting this ADR.
- The execution context contract (#58) must include the attempt folder and the data and result commands that agents use to report outcomes.
- The observability boundary (#60) decides how adapter activity reaches the activity log.
