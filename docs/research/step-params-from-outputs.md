# How other workflow tools set step parameters from earlier outputs

Research for [#234](https://github.com/nordbotten/loopfile/issues/234), a child of the map
[#226](https://github.com/nordbotten/loopfile/issues/226). This file looks at four tools:
GitHub Actions, Argo Workflows, Tekton, and Temporal. For each, it answers the same five
questions:

1. Where the value comes from.
2. When the value is resolved.
3. What is checked before the run.
4. What happens with a bad or empty value.
5. How the resolved value is logged or shown.

## GitHub Actions

### Where the value comes from

A step or job writes a key-value pair to the `GITHUB_OUTPUT` file. Example:
`echo "{name}={value}" >> "$GITHUB_OUTPUT"`.
A later step reads it as `steps.<id>.outputs.<name>`. A later job reads a job output as
`needs.<job_id>.outputs.<output_name>`, after the job declares it under `jobs.<job_id>.outputs`.
Source: [Workflow commands for GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions),
[Defining outputs for jobs](https://docs.github.com/en/actions/using-jobs/defining-outputs-for-jobs).

The value fills an expression written as `${{ <expression> }}`, for example in `runs-on`,
`with`, or a matrix. `fromJSON()` turns a string output into a list or object, for example
`${{ fromJSON(needs.job1.outputs.matrix) }}` to build a matrix from an earlier job's JSON
output. Source: [Evaluate expressions in workflows and actions](https://docs.github.com/en/actions/learn-github-actions/expressions).

### When the value is resolved

A job only starts after every job it `needs` finishes, so the job's outputs exist by the
time a dependent job's expressions are read.
Source: [Defining outputs for jobs](https://docs.github.com/en/actions/using-jobs/defining-outputs-for-jobs).
Expressions such as `runs-on` and `if` are evaluated by the GitHub Actions service before
the job is handed to a runner, not by the runner itself.
Source: community discussion on [`if` condition evaluation](https://github.com/actions/runner/issues/1173) and
[Using conditions to control job execution](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/using-conditions-to-control-job-execution).

### What is checked before the run

Falsy values (`false`, `0`, `-0`, `""`, `''`, `null`) are coerced to `false` in a
conditional; comparisons use loose typing with automatic type coercion and case-insensitive
string compare. Source: [Evaluate expressions in workflows and actions](https://docs.github.com/en/actions/learn-github-actions/expressions).
A job matrix is capped at 256 generated jobs per workflow run.
Source: [Actions limits](https://docs.github.com/en/actions/reference/limits),
also stated in [cloudposse/github-action-matrix-extended](https://github.com/cloudposse/github-action-matrix-extended).
Outputs are capped at about 1 MB per step/job and 50 MB total per workflow run (UTF-16
measured); going over truncates or fails the step.
Source: [RunsOn — Passing data between steps and jobs](https://runs-on.com/github-actions/passing-data-between-jobs/),
cross-checked against [Actions limits](https://docs.github.com/en/actions/reference/limits) (which states the 256-job
matrix cap directly but does not itself restate the output byte limits).

### What happens with a bad or empty value

If a workflow parameter expression cannot resolve — for example a required value with no
default — the run fails with an explicit resolve error at that point.
Source: [Evaluate expressions in workflows and actions](https://docs.github.com/en/actions/learn-github-actions/expressions).
An output that was never set reads back as an empty string when referenced, it does not by
itself fail the run; a workflow author must add its own `if` check to guard on that.
`hashFiles()` is a documented example of a built-in function that returns an empty string
on no match, showing the general pattern of "empty string, not error" for absent values.
Source: [Evaluate expressions in workflows and actions](https://docs.github.com/en/actions/learn-github-actions/expressions).
Once a value has been registered as a secret with `add-mask`, it can no longer be set as an
output. Source: [Workflow commands for GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions).

### How the resolved value is logged

The run log for each step shows the commands that ran, so an output set with `echo
"name=value" >> "$GITHUB_OUTPUT"` is visible in that step's own log line, in plain text,
unless the value matches a registered secret mask. Masked secrets used as outputs are
disallowed outright rather than shown redacted (see above). Documentation confirms the
mask/output interaction; a dedicated "resolved value" log view outside the step's own log
is not documented as a separate feature.
Source: [Workflow commands for GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions).

## Argo Workflows

### Where the value comes from

A parameter can come from `spec.arguments.parameters` (workflow-level, read as
`{{workflow.parameters.<name>}}`), from a step or task's own declared output
(`{{steps.<name>.outputs.parameters.<param>}}` or
`{{tasks.<name>.outputs.parameters.<param>}}`), or from an expression tag
(`{{=steps.producer.outputs.parameters.msg}}`), which additionally supports a `??` fallback
operator. Source: [Walk-through: Parameters](https://argo-workflows.readthedocs.io/en/latest/walk-through/parameters/),
[Variables](https://argo-workflows.readthedocs.io/en/latest/variables/).

### When the value is resolved

Substitution happens during node reconciliation, before the pod for the consuming step is
created — the controller resolves `{{ }}` and `{{= }}` tags with `common.ProcessArgs`
against the accumulated scope at that point in the DAG.
Source: [DeepWiki summary of argoproj/argo-workflows variable resolution](https://deepwiki.com/argoproj/argo-workflows/3.8-variables-and-parameters)
(a secondary source; no single official doc page states the exact call site, but it agrees
with the documented DAG dependency ordering in
[Walk-through: Parameters](https://argo-workflows.readthedocs.io/en/latest/walk-through/parameters/)).

### What is checked before the run

Argo distinguishes an "absent" output (never produced) from a "legitimately empty" output
(produced, but as an empty string). Source: [Variables](https://argo-workflows.readthedocs.io/en/latest/variables/).
Parameters should be quoted (`"{{inputs.parameters.message}}"`) in YAML because the curly
braces would otherwise break YAML parsing.
Source: [Walk-through: Parameters](https://argo-workflows.readthedocs.io/en/latest/walk-through/parameters/).

### What happens with a bad or empty value

If a referenced parameter cannot resolve at all (for example, a declared workflow
parameter with no value and no default), the workflow fails with an explicit error such as
`failed to resolve {{workflow.parameters.log-level}}`. This is why Argo's own docs recommend
giving a parameter a default rather than relying only on a value supplied at submit time.
Source: [Walk-through: Parameters](https://argo-workflows.readthedocs.io/en/latest/walk-through/parameters/).
For a step/task output specifically: if the value is "absent" (never produced) and there is
no `valueFrom.default` and no `??` fallback, the referencing node fails outright with a
terminal error. A legitimately empty string is not treated as absent, so a `??` fallback
does not trigger for an empty-but-present value.
Source: [Variables](https://argo-workflows.readthedocs.io/en/latest/variables/).

### How the resolved value is logged

Not documented on the two pages checked. No official page states a distinct "resolved
parameter" log or UI view separate from the workflow's stored, substituted manifest; this
is a documentation gap rather than a confirmed absence of the feature, and is called out
below as unverified.

## Tekton

### Where the value comes from

A Task or Pipeline declares typed `params` (string, array, or object). A later Task in the
same Pipeline can take another Task's declared `results` as a param value, using
`$(tasks.<taskName>.results.<resultName>)` for a string result,
`$(tasks.<taskName>.results.<resultName>[*])` / `[i]` for an array, and
`$(tasks.<taskName>.results.<resultName>[*])` / `.key` for an object.
Source: [Tekton Pipelines docs — Passing one Task's results into the parameters or when
expressions of another](https://tekton.dev/docs/pipelines/pipelines/#passing-one-tasks-results-into-the-parameters-or-when-expressions-of-another).

### When the value is resolved

The Tekton controller performs string substitution when the `PipelineRun` executes, at the
point each Task actually runs — not at Pipeline authoring or admission time. Referencing
another Task's result automatically creates an ordering dependency, so Tekton runs the
producing Task first. Source: [Tekton Pipelines docs — Tasks](https://tekton.dev/docs/pipelines/pipelines/#specifying-parameters)
and the same results section above.

### What is checked before the run

Before execution, Tekton checks: parameter type (string vs array vs object must match the
declared type), parameter name format (must start with a letter or underscore; only
alphanumerics, hyphens, underscores), and (as a beta feature) `enum` constraints on allowed
values. Source: [Tekton Pipelines docs — Specifying Parameters](https://tekton.dev/docs/pipelines/pipelines/#specifying-parameters).
A Task's results are carried back to the controller through the container's Kubernetes
termination message, which caps a Task's total result payload at about 4096 bytes (shared
across all steps/containers in that Task's pod, and reduced further by Tekton's own
bookkeeping inside that message). Going over truncates the JSON, `json.Unmarshal` fails, and
Tekton discards the results even though the TaskRun itself reports "Succeeded."
Source: [tektoncd/pipeline — developer docs: results lifecycle](https://github.com/tektoncd/pipeline/blob/main/docs/developers/results-lifecycle.md),
corroborated by [tektoncd/pipeline issue #4060](https://github.com/tektoncd/pipeline/issues/4060).
A configurable-limit workaround (sidecar logs) and a Workspace-based alternative exist for
larger values. Source: same results-lifecycle doc.

### What happens with a bad or empty value

If the producing Task finishes successfully but never actually writes the referenced
result, the consuming Task fails with reason `InvalidTaskResultReference`, and the error
names the missing result explicitly, for example: `unable to find result referenced by
param 'foo' in 'task'; Could not find result with name 'commit' for task run
'checkout-source'`. Source: [Tekton Pipelines docs — Passing results](https://tekton.dev/docs/pipelines/pipelines/#passing-one-tasks-results-into-the-parameters-or-when-expressions-of-another).
If the producing Task is skipped, the consuming Task is also skipped, with reason `Results
were missing`. If a Task uses `onError: continue` and fails before initializing its result,
a downstream Task referencing that result either fails or is skipped, depending on that
downstream Task's own error handling. Source: same page.

### How the resolved value is logged

Final Pipeline-level results appear in `PipelineRun.status.pipelineResults` once the run
completes. A failing or missing result reference is written as a status condition/message
naming the specific missing result (see the `InvalidTaskResultReference` message above), so
the failure is visible on the `PipelineRun`/`TaskRun` status rather than only in step logs.
Source: [Tekton Pipelines docs — Passing results](https://tekton.dev/docs/pipelines/pipelines/#passing-one-tasks-results-into-the-parameters-or-when-expressions-of-another).

## Temporal (fourth tool, for contrast)

Temporal is a different shape of tool — a durable-execution SDK, not a YAML/DAG workflow
engine — but it is relevant because it is the strictest of the four about typing an
earlier step's (Activity's) output before it can feed a later call.

### Where the value comes from

A Workflow function calls an Activity function directly in code (not through string
templating). The Activity's return value is an ordinary typed value in the host language
(for example a Go struct or TypeScript object), returned to the calling Workflow function
by an SDK-generated stub. Source: [Temporal docs — Workflows](https://docs.temporal.io/workflows).

### When the value is resolved

The Activity runs once; its result is recorded as an event in the Workflow's Event
History. On replay (Temporal's deterministic re-execution of Workflow code), the recorded
result is reused rather than the Activity being re-run, which is how Temporal keeps replay
deterministic. Source: [Temporal docs — Workflows](https://docs.temporal.io/workflows).

### What is checked before the run

Values crossing the Workflow/Activity boundary are serialized through the SDK's data
converter, so a type mismatch is a compile-time or serialization-time error in the SDK's
host language, not a runtime string-substitution failure. (The fetched page describes the
Event History and replay mechanism directly but does not itself spell out the data
converter's checks; that mechanism is part of Temporal's documented SDK model referenced
from the same Workflows page and is flagged here as needing a follow-up read of the
language-specific SDK docs if load-time checking detail is needed.)

### What happens with a bad or empty value

Not covered in the page fetched. Temporal's determinism rules mean a value that changes
between the original run and a replay (for example `Date.now()` or a random number used
directly in Workflow code) can make the Workflow take a different path than its recorded
history, which Temporal treats as a determinism violation. This is the closest documented
analogue to "bad value" handling on the page read.
Source: [Temporal docs — Workflows](https://docs.temporal.io/workflows).

### How the resolved value is logged

Every Workflow Execution emits Commands and processes Events, and these are recorded in the
Event History, which the Temporal Web UI displays per Workflow run. The fetched page does
not go into how individual Activity input/output payloads render in that UI (for example,
truncation or payload size caps); this is flagged as unverified from the page read.
Source: [Temporal docs — Workflows](https://docs.temporal.io/workflows).

## Gaps and follow-ups

- Argo Workflows UI display of resolved values was not found on the two official pages
  fetched. A follow-up read of the Argo UI docs would be needed to confirm.
- Temporal's data-converter type checking and UI payload display were not found on the one
  page fetched; the SDK-specific docs (for example the Go or TypeScript SDK pages) would
  answer this in more detail.
- GitHub Actions: the exact byte limits for `GITHUB_OUTPUT` (roughly 1 MB per job, 50 MB per
  workflow run) come from a secondary source (RunsOn), not an official GitHub page found
  during this pass; the 256-job matrix cap is confirmed on the official
  [Actions limits](https://docs.github.com/en/actions/reference/limits) page.

## What this means for Loopfile

Facts only, for the open tickets:

- **For [#230](https://github.com/nordbotten/loopfile/issues/230) (value source, syntax, empty value):**
  - All four tools give a step field's value a distinct syntax from a literal: GitHub
    Actions uses `${{ }}` expressions, Argo uses `{{ }}` / `{{= }}` tags, Tekton uses
    `$( )` variable references, Temporal uses ordinary typed code (no template syntax at
    all, because the "template" is the host language).
  - Three of the four (GitHub Actions, Argo, Tekton) treat "value never produced" and
    "value produced but empty" as different cases. GitHub Actions and Tekton read an
    unset value as an error condition tied to the reference, not silently as empty
    (GitHub Actions: unresolved required parameter fails the run explicitly; Tekton: a
    result that was never written fails the consuming Task with
    `InvalidTaskResultReference`). Argo explicitly separates "absent" (fails unless a
    default or `??` fallback exists) from "empty string" (passes through as-is,
    fallback does not trigger).
  - Argo's `??` fallback operator is the only one of the four with a documented
    value-level default/fallback syntax at the reference site itself, as opposed to a
    default declared once on the parameter.

- **For [#231](https://github.com/nordbotten/loopfile/issues/231) (load-time checks vs
  call-time failure):**
  - Tekton checks parameter type (string/array/object) and name format before a
    Pipeline/Task runs, and (beta) `enum` constraints on allowed values — this is a
    load/admission-time check, independent of any particular run's data.
  - GitHub Actions checks matrix size (max 256 generated jobs) and applies output size
    caps (about 1 MB per job / 50 MB per run) — these are structural/size checks, not
    checks on the value's content.
  - None of the four tools documented here validate the *content* of a value used to
    fill a later step's field against an allow-list at load time — Tekton's `enum` is
    the closest (declared allowed values, checked before run), but it is on the
    Pipeline's own declared param, not on a value flowing in from a previous step's
    result.
  - All four fail the consuming step at call time (not at load time) when the actual
    value referenced turns out to be missing: GitHub Actions (unresolved expression
    fails the run), Argo (absent output fails the node unless a default/fallback is
    given), Tekton (`InvalidTaskResultReference` fails the consuming Task), Temporal
    (a changed/non-deterministic value fails Workflow replay, not the original run).
