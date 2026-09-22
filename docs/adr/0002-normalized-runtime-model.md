# Loaders build one normalized model from a materialized Loopfile

Directory, thin `.loop` and packed `.loop` inputs are all loaded into one internal model. Workflow execution, routing, executors and run state depend only on that model. They never read YAML or know which input type a run came from. At launch, the input is first turned into a materialized Loopfile: a run-owned, fixed copy outside the target repository. The model is built from it. This keeps manifest syntax and versioning changes inside the loaders, and makes "which Loopfile did this run use?" exact.

## Decisions

- **Materialized Loopfile:** made at launch. A directory is copied, a packed `.loop` is extracted, a thin `.loop` is written out. Edits to the source during a run do not change the run.
- **Inline prompts:** a `prompt` string is written as a file and then handled like `promptFile`. The model only holds prompt file paths. The file goes in a run-owned folder next to the materialized Loopfile, never inside it, so the materialized Loopfile stays a verbatim copy of what the Loopfile shipped (#81).
- **Model shape:** plain, read-only, JSON-serializable data. No classes or methods. Routing logic lives in the runtime.
- **Defaults:** the loader fills in every default. The runtime never sees a missing value.
- **Validation:** all of it happens in the loader, with manifest locations in the errors. An invalid manifest never becomes a model. The model keeps no YAML locations. Runtime errors refer to step IDs.
- **Assets:** paths inside the materialized Loopfile. The loader checks they exist. A step reads them when an attempt starts.
- **Persistence:** only the materialized Loopfile is kept. Resume and a detached worker rebuild the model from it.

## Considered Options

- **Runtime reads the parsed manifest directly:** less code now, but manifest syntax (#02) and version (#59) changes would reach into the runtime.
- **Read from the source without a copy:** edits during a run could change prompts mid-run, and detach and resume would each have to solve this again.
- **Model holds prompt text:** same result, since the materialized Loopfile never changes, but the model grows.
- **Persist the built model:** a second copy of the truth that can drift from the materialized Loopfile.

## Consequences

- A Loopfile upgrade between a crash and a resume could rebuild a different model. Handled by the versioning decision (#59).
- The digest that identifies a run's Loopfile (original input or materialized Loopfile) is left to the run state model (#13).
