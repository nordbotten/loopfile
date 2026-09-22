/**
 * Runs a workflow from its first step to an end state (#116, #34).
 *
 * This is the run owner's loop. It loads the Loopfile (#4), makes the
 * workspace (#16), and for each visit starts the step through the local
 * executor (#12), lets deterministic routing (#27) pick the next target, and
 * appends every fact to the event log (#28). No model chooses a route: the
 * step's exit and the outcome it reported through `loopfile result` are all
 * routing reads.
 *
 * Every step kind runs here — command, agent and Ralph — and the loop honours
 * `maxAttempts`, `maxTransitions`, `runTimeout` and each step's `timeout`
 * (`docs/manifest-v1.md#limits`). The step kinds are told apart by `kind`,
 * never by a harness name: the adapter table picks the harness.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { checkAttemptLimit } from "../application/attempt-limit.ts";
import { sha256 } from "../application/data-store.ts";
import {
  CANCEL_GRACE_MS,
  type Ended,
  type ExecutionContext,
  type Executor,
  type StartResult,
} from "../application/executor.ts";
import type { HarnessActivity, HarnessAdapters } from "../application/harness.ts";
import type { LaunchInputs } from "../application/launch-inputs.ts";
import type { AttemptIdentity } from "../application/owner-protocol.ts";
import { nextAttemptId, parseEventLog, replay } from "../application/replay.ts";
import { resumePlan, resumeRefusal } from "../application/resume.ts";
import { route } from "../application/routing.ts";
import {
  checkRunTimeout,
  checkTransitionLimit,
  type LimitCheck,
  type RunEndedFields,
} from "../application/run-limits.ts";
import { parseStatusProjection } from "../application/status.ts";
import { type HarnessData, NO_HARNESS_DATA } from "../application/status-projection.ts";
import {
  type AttemptEndFields,
  endOfAttempt,
  endStateEvent,
  modelDigest,
  START_FAILED_END,
} from "../application/workflow-run.ts";
import {
  EVENT_FORMAT_VERSION,
  type LaunchInputRecord,
  type RunCreated,
  type RunEvent,
} from "../domain/events.ts";
import {
  type AgentStep,
  type CommandStep,
  isEndState,
  type RalphStep,
  type Step,
  type Workflow,
} from "../domain/model.ts";
import { startAgentStep } from "./agent-step.ts";
import { type AttemptPaths, createAttemptDirectory } from "./attempt-directory.ts";
import { startCommandStep } from "./command-step.ts";
import { dataGetHandler } from "./data-get-handler.ts";
import { dataPutHandler } from "./data-put-handler.ts";
import {
  loadDirectory,
  MANIFEST_NAME,
  materializeDirectory,
  materializePacked,
  materializeThin,
  materializeThinText,
} from "./directory-loader.ts";
import type { EventLog, NewEvent } from "./event-log.ts";
import { harnessActivityRouter } from "./harness-activity-router.ts";
import { DEFAULT_HARNESS_ADAPTERS } from "./harness-adapters.ts";
import { groupAlive } from "./local-executor.ts";
import { runRalphStep } from "./ralph-step.ts";
import { resultHandler } from "./result-handler.ts";
import { type RunPaths, runPaths } from "./run-directory.ts";
import { type AttemptCallHandler, type RunOwner, startRunOwner } from "./run-owner.ts";
import { openStatusWriter, type StatusWriter } from "./status-writer.ts";
import {
  createWorkspace,
  keptWorkspaceMessage,
  removeWorkspace,
  type Workspace,
} from "./workspace.ts";

/** Thrown when a run cannot go from start to end. The message says why. */
export class WorkflowRunError extends Error {}

export interface ExecuteRunOptions {
  /** The Loopfile home, usually from `loopfileHome()`. */
  readonly home: string;
  /** The run's folder is already made, the way the CLI leaves it (#81). */
  readonly runId: string;
  /** The Loopfile's source. It is copied into the run and loaded from the copy. */
  readonly source: string;
  /** What `source` is. Left out means a source folder. */
  readonly sourceKind?: "directory" | "thin" | "packed";
  /** Manifest text handed over by `loopfile -`; stdin is not available to the owner. */
  readonly sourceText?: string;
  /**
   * The launch inputs. Each is written to `inputs/<name>` before `run.created`,
   * which records its name, size and digest but not its value (#35).
   */
  readonly inputs?: LaunchInputs;
  /** The target repository the workspace is made from. */
  readonly repository: string;
  readonly executor: Executor;
  /** The harness adapter table. Defaults to the real one; tests give the fake behind a real name. */
  readonly adapters?: HarnessAdapters;
  /** A signal to the run owner, which cancels the run like `loopfile cancel` does (#63). */
  readonly cancelSignal?: AbortSignal;
  /** Overridable for tests only. */
  readonly eventLog?: EventLog;
}

/** How a run ended, as its `run.ended` event says. */
export interface ExecutedRun {
  readonly result: "success" | "failure" | "cancelled";
  /** Set when the workspace stayed: where it is and why. Only a successful run removes it. */
  readonly workspaceKept?: string;
}

/** What the run owner made before its first event: the workflow and the workspace. */
interface Prepared {
  readonly workflow: Workflow;
  readonly workspace: Workspace;
}

/**
 * Starts the run owner for a fresh run, runs the workflow to its end and
 * writes `run.ended`. The run owner is closed when this returns or throws.
 *
 * Only a run with no `run.created` yet is run here: continuing one is resume.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<ExecutedRun> {
  const paths = runPaths(options.home, options.runId);
  const existing = await readFile(paths.events, "utf8").catch(() => "");
  if (existing !== "") {
    throw new WorkflowRunError(`run ${options.runId} already started: ${paths.events}`);
  }

  let prepared: Prepared | undefined;
  const owner = await startRunOwner({
    home: options.home,
    runId: options.runId,
    ...cancelSignalOf(options),
    ...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
    created: async () => {
      const made = await prepare(options, paths);
      prepared = made.prepared;
      return made.created;
    },
  });
  try {
    if (prepared === undefined) throw new WorkflowRunError("the run was never prepared");
    const entry = prepared.workflow.steps[0]?.id ?? "$success";
    return await runSteps(options, owner, prepared, basename(options.source), async () => ({
      to: entry,
    }));
  } finally {
    await owner.close();
  }
}

/** What resuming a crashed run needs. Everything else is read from its run folder. */
export interface ResumeRunOptions {
  /** The Loopfile home, usually from `loopfileHome()`. */
  readonly home: string;
  readonly runId: string;
  readonly executor: Executor;
  /** The harness adapter table. Defaults to the real one; tests give the fake behind a real name. */
  readonly adapters?: HarnessAdapters;
  /** A signal to the run owner, which cancels the run like `loopfile cancel` does (#63). */
  readonly cancelSignal?: AbortSignal;
}

/**
 * Starts a new run owner for a crashed run and runs it to its end (#64).
 *
 * The model is rebuilt from the Materialized Loopfile and must match the one
 * `run.created` recorded (ADR 0006). The new owner appends `owner.started`,
 * then `attempt.interrupted` for an attempt with a start and no end, and goes
 * on from the last complete state in the same workspace. Nothing already in
 * the run folder is changed. The command checks all of this first, where a
 * person reads the error; it is checked again here because this is the process
 * that writes.
 */
export async function resumeRun(options: ResumeRunOptions): Promise<ExecutedRun> {
  const paths = runPaths(options.home, options.runId);
  const workflow = await loadMaterialized(paths);
  const refused = resumeRefusal(await readEvents(paths), modelDigest(workflow));
  if (refused !== undefined) throw new WorkflowRunError(refused);

  const owner = await startRunOwner({
    home: options.home,
    runId: options.runId,
    ...cancelSignalOf(options),
  });
  try {
    const created = (await readEvents(paths))[0] as RunCreated;
    const workspace: Workspace = {
      path: paths.workspace,
      repositoryPath: created.repositoryPath,
      baseCommit: created.baseCommit,
      branch: created.branch,
    };
    const run = { ...options, source: paths.loopfile, repository: created.repositoryPath };
    return await runSteps(run, owner, { workflow, workspace }, await loopfileNameOf(paths), (t) =>
      resumeFrom(workflow, t),
    );
  } finally {
    await owner.close();
  }
}

/** `cancelSignal`, only when there is one to pass on. */
function cancelSignalOf(options: { readonly cancelSignal?: AbortSignal }) {
  return options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal };
}

/** Loads the run's Materialized Loopfile into the model. */
export async function loadMaterialized(paths: RunPaths): Promise<Workflow> {
  const loaded = await loadDirectory(paths.loopfile);
  if (loaded.status !== "loaded") {
    throw new WorkflowRunError(`the Materialized Loopfile did not load: ${paths.loopfile}`);
  }
  return loaded.workflow;
}

async function readEvents(paths: RunPaths): Promise<readonly RunEvent[]> {
  return parseEventLog(await readFile(paths.events, "utf8"));
}

/** The name the first run owner put in `status.json`, so a resume keeps showing it. */
async function loopfileNameOf(paths: RunPaths): Promise<string> {
  return await readFile(paths.status, "utf8")
    .then((text) => parseStatusProjection(JSON.parse(text)).loopfileName)
    .catch(() => basename(paths.loopfile));
}

/**
 * Interrupts the unfinished attempt, if there is one, and gives where the run
 * goes on. A step that gets a new attempt is checked against its
 * `maxAttempts` first: the interrupted attempt counts (ADR 0003).
 */
async function resumeFrom(workflow: Workflow, tracked: Tracked): Promise<Moved> {
  const { interrupted, next } = resumePlan(workflow, tracked.history);
  if (interrupted !== undefined) {
    await tracked.log.append({ type: "attempt.interrupted", attemptId: interrupted.attemptId });
  }
  if (next.kind === "end") return { event: endStateEvent(next.state) };
  const step = workflow.steps.find((candidate) => candidate.id === next.stepId);
  if (step === undefined) throw new WorkflowRunError(`no step ${next.stepId}`);
  if (next.kind === "route") {
    return await move(
      workflow,
      step,
      { kind: "ended", attemptId: next.attemptId, end: next.end },
      tracked,
    );
  }
  const attempts = checkAttemptLimit(step, replay(tracked.history));
  return attempts.allowed ? { to: step.id } : { event: attempts.event };
}

/** Loads the Loopfile, makes the workspace, and builds the `run.created` that records both. */
async function prepare(
  options: ExecuteRunOptions,
  paths: RunPaths,
): Promise<{ readonly prepared: Prepared; readonly created: NewEvent }> {
  const workflow = await loadRunWorkflow(options, paths);
  const inputs = await writeInputs(options.inputs ?? {}, paths.inputs);
  const workspace = await createWorkspace({
    repository: options.repository,
    path: paths.workspace,
    runId: options.runId,
  });
  return {
    prepared: { workflow, workspace },
    created: {
      type: "run.created",
      runId: options.runId,
      eventFormatVersion: EVENT_FORMAT_VERSION,
      modelDigest: modelDigest(workflow),
      repositoryPath: workspace.repositoryPath,
      baseCommit: workspace.baseCommit,
      branch: workspace.branch,
      inputs,
    },
  };
}

/** Where the walk begins: a target to visit, or the run's end. */
type Begin = (tracked: Tracked) => Promise<Moved>;

async function runSteps(
  options: ExecuteRunOptions,
  owner: RunOwner,
  { workflow, workspace }: Prepared,
  loopfileName: string,
  begin: Begin,
): Promise<ExecutedRun> {
  let status: StatusWriter | undefined;
  let tracked: Tracked | undefined;
  try {
    const history = parseEventLog(await readFile(owner.paths.events, "utf8")).slice();
    status = await openStatusWriter({
      path: owner.paths.status,
      workflow,
      loopfileName,
      events: history,
    });
    tracked = tracking(owner.events, history, status);
    const ended = await walk(
      options,
      owner,
      workflow,
      tracked,
      workspace.path,
      loopfileName,
      begin,
    );
    if (ended.result !== "success") {
      await status.flush();
      return { result: ended.result };
    }
    const removal = await removeWorkspace(workspace);
    await status.flush();
    return removal.removed
      ? { result: ended.result }
      : { result: ended.result, workspaceKept: keptWorkspaceMessage(removal) };
  } catch (error) {
    await appendInternalError(tracked?.log ?? owner.events, tracked?.history ?? []);
    await status?.flush().catch(() => undefined);
    throw error;
  }
}

/**
 * Visits steps until the run ends, and appends `run.ended`. A cancel appends
 * `run.cancelled` instead: after `attempt.interrupted` when an attempt was
 * running, on its own between attempts (#63).
 */
async function walk(
  options: ExecuteRunOptions,
  owner: RunOwner,
  workflow: Workflow,
  tracked: Tracked,
  workspace: string,
  loopfileName: string,
  begin: Begin,
): Promise<{ readonly result: ExecutedRun["result"] }> {
  const begun = await begin(tracked);
  if ("event" in begun) return await end(tracked, begun.event);
  let target = begun.to;
  while (!isEndState(target)) {
    if (owner.cancelled.aborted) return await cancelRun(tracked);
    const step = workflow.steps.find((candidate) => candidate.id === target);
    if (step === undefined) throw new WorkflowRunError(`no step ${target}`);
    const visited = await visit(options, owner, workflow, step, tracked, workspace, loopfileName);
    if (visited.kind === "interrupted") {
      const ended = await interruptedStep(step, visited, tracked);
      if (ended !== undefined) return ended;
      target = step.id;
      continue;
    }

    const moved = await move(workflow, step, visited, tracked);
    if ("event" in moved) return await end(tracked, moved.event);
    target = moved.to;
  }
  return await end(tracked, endStateEvent(target));
}

/** Routes an ended attempt, checks the limits, records the move. Gives the next target, or the run's end. */
async function move(
  workflow: Workflow,
  step: Step,
  visited: Extract<Visited, { kind: "ended" }>,
  tracked: Tracked,
): Promise<Moved> {
  const { to, cause } = route(workflow, step.id, visited.end);
  const state = replay(tracked.history);
  const refused =
    refusal(checkTransitionLimit(workflow, state.transitions.length)) ??
    refusal(checkRunTimeout(workflow, state.ownerTimeMs));
  if (refused !== undefined) return { event: refused };

  await tracked.log.append({
    type: "transition",
    from: step.id,
    attemptId: visited.attemptId,
    ...visited.end,
    to,
    cause,
  });
  const next = workflow.steps.find((candidate) => candidate.id === to);
  const attempts =
    next === undefined ? undefined : checkAttemptLimit(next, replay(tracked.history));
  return attempts?.allowed === false ? { event: attempts.event } : { to };
}

/** The next target, or the run's end. */
type Moved = { readonly to: string } | { readonly event: RunEndedFields };

async function interruptedStep(
  step: Step,
  visited: Extract<Visited, { kind: "interrupted" }>,
  tracked: Tracked,
): Promise<{ readonly result: ExecutedRun["result"] } | undefined> {
  await tracked.log.append({ type: "attempt.interrupted", attemptId: visited.attemptId });
  if (visited.by === "cancel") return await cancelRun(tracked);
  if (visited.by === "run_timeout") return await end(tracked, RUN_TIMEOUT_END);
  const attempts = checkAttemptLimit(step, replay(tracked.history));
  return attempts.allowed ? undefined : await end(tracked, attempts.event);
}

const RUN_TIMEOUT_END: RunEndedFields = {
  type: "run.ended",
  result: "failure",
  reason: "run_timeout",
};

function refusal(check: LimitCheck): RunEndedFields | undefined {
  return check.allowed ? undefined : check.event;
}

async function end(tracked: Tracked, event: RunEndedFields): Promise<RunEndedFields> {
  const ended = { ...event, metrics: tracked.harnessData.metrics };
  await tracked.log.append(ended);
  return ended;
}

/** Records a run-owner bug without hiding the bug or turning a failed write into success. */
export async function appendInternalError(
  log: EventLog,
  history: readonly RunEvent[],
): Promise<void> {
  const last = history.at(-1);
  if (last?.type === "run.ended" || last?.type === "run.cancelled") return;
  await log
    .append({ type: "run.ended", result: "failure", reason: "internal_error" })
    .catch(() => undefined);
}

async function cancelRun(tracked: Tracked): Promise<{ readonly result: "cancelled" }> {
  await tracked.log.append({ type: "run.cancelled", metrics: tracked.harnessData.metrics });
  return { result: "cancelled" };
}

/** Writes each launch input's text to `<folder>/<name>` and returns what `run.created` records of it. */
async function writeInputs(
  inputs: LaunchInputs,
  folder: string,
): Promise<readonly LaunchInputRecord[]> {
  const records: LaunchInputRecord[] = [];
  for (const [name, text] of Object.entries(inputs)) {
    await mkdir(folder, { recursive: true });
    const bytes = Buffer.from(text);
    await writeFile(join(folder, name), bytes, { flag: "wx" });
    records.push({ name, size: bytes.length, digest: sha256(bytes) });
  }
  return records;
}

/** Copies the Loopfile into the run and loads the copy. */
async function loadRunWorkflow(options: ExecuteRunOptions, paths: RunPaths): Promise<Workflow> {
  await materialize(options, paths.loopfile);
  const loaded = await loadDirectory(paths.loopfile);
  if (loaded.status !== "loaded") {
    throw new WorkflowRunError(`the Loopfile at ${options.source} did not load: ${loaded.status}`);
  }
  await writeInlinePrompts(paths);
  return loaded.workflow;
}

function materialize(options: ExecuteRunOptions, destination: string): Promise<void> {
  if (options.sourceText !== undefined) return materializeThinText(options.sourceText, destination);
  if (options.sourceKind === "thin") return materializeThin(options.source, destination);
  if (options.sourceKind === "packed") return materializePacked(options.source, destination);
  return materializeDirectory(options.source, destination);
}

/**
 * Writes each inline `prompt` to the run-owned `prompts/<step>.md` that the
 * model names as the step's `promptFile` (`inlinePromptFile`). The model holds
 * paths only, so the text is read from the manifest copy in the run, which the
 * loader has just accepted.
 */
async function writeInlinePrompts(paths: RunPaths): Promise<void> {
  const manifest = parseDocument(
    await readFile(join(paths.loopfile, MANIFEST_NAME), "utf8"),
  ).toJS();
  const steps: unknown = manifest?.steps;
  if (!Array.isArray(steps)) return;
  await mkdir(paths.prompts, { recursive: true });
  for (const step of steps) {
    if (typeof step?.prompt !== "string") continue;
    await writeFile(join(paths.prompts, `${step.id}.md`), step.prompt);
  }
}

/** How one visit finished: an attempt end to route on, or a run timeout that cut it short. */
type Visited =
  | { readonly kind: "ended"; readonly attemptId: string; readonly end: AttemptEndFields }
  | { readonly kind: "interrupted"; readonly attemptId: string; readonly by: StopReason };

/** One visit to a step: start, wait, end. The run's loop routes on what it returns. */
async function visit(
  options: ExecuteRunOptions,
  owner: RunOwner,
  workflow: Workflow,
  step: Step,
  tracked: Tracked,
  workspace: string,
  loopfileName: string,
): Promise<Visited> {
  const attemptId = nextAttemptId(replay(tracked.history), step.id);
  const startedAt = new Date().toISOString();
  const attempt = await createAttemptDirectory(owner.paths.attempts, attemptId);
  let current: AttemptIdentity | undefined;
  const served = await owner.serveAttempt({
    socketPath: attempt.socket,
    current: () => current,
    handle: dispatch(tracked, owner, step),
  });
  const guard = attemptGuard(
    workflow,
    tracked.history,
    options.executor,
    owner.cancelled,
    served.interruptSignal,
  );
  try {
    const secret = randomBytes(16).toString("hex");
    current = { attemptId, secret };
    const context = {
      runId: owner.runId,
      attemptId,
      stepId: step.id,
      workspace,
      scratch: attempt.scratch,
      endpoint: served.endpoint,
      attemptSecret: secret,
    };
    const ended = await runStep(
      { ...options, executor: guard.executor },
      owner,
      workflow,
      step,
      tracked,
      {
        context,
        attempt,
        startedAt,
        loopfileName,
        interruptSignal: served.interruptSignal,
        stopSignal: AbortSignal.any([owner.cancelled, served.interruptSignal]),
        setCurrent: (identity) => {
          current = identity;
        },
        onProcess: (processGroupId) =>
          tracked.log.append({
            type: "attempt.started",
            attemptId,
            stepId: step.id,
            processGroupId,
            at: startedAt,
          }),
      },
    );
    const by = guard.stoppedBy();
    if (by === "cancel" || by === "interrupt") await guard.drained();
    if (by !== undefined) return { kind: "interrupted", attemptId, by };
    await tracked.log.append({ type: "attempt.ended", attemptId, ...ended });
    return { kind: "ended", attemptId, end: ended };
  } finally {
    guard.clear();
    await served.close();
  }
}

/** What `runStep` needs to start one attempt and tell the run owner about it. */
interface StepStart {
  readonly context: ExecutionContext;
  readonly attempt: AttemptPaths;
  readonly startedAt: string;
  readonly loopfileName: string;
  readonly interruptSignal: AbortSignal;
  readonly stopSignal: AbortSignal;
  setCurrent(identity: AttemptIdentity | undefined): void;
  /** Records `attempt.started`. 0 is a process that never started, since no group has it. */
  onProcess(processGroupId: number): Promise<unknown>;
}

/** Starts the step by its kind and waits for the attempt end. */
async function runStep(
  options: ExecuteRunOptions,
  owner: RunOwner,
  workflow: Workflow,
  step: Step,
  tracked: Tracked,
  start: StepStart,
): Promise<AttemptEndFields> {
  const { context } = start;
  const adapters = options.adapters ?? DEFAULT_HARNESS_ADAPTERS;
  const activity = activityFor(owner, tracked, context.attemptId);
  if (step.kind === "ralph") {
    return await runRalph({ options, adapters, owner, workflow, tracked, start, activity }, step);
  }

  const started = await startProcessStep(options, owner, workflow, tracked, step, start, activity);
  // A process that never started has no group. 0 is that, since no group has it.
  await start.onProcess(started.kind === "running" ? started.processGroupId : 0);
  if (started.kind !== "running") return START_FAILED_END;
  return await waitForEnd(started, step, tracked, context.attemptId);
}

/** Starts a command or agent step's process. */
function startProcessStep(
  options: ExecuteRunOptions,
  owner: RunOwner,
  workflow: Workflow,
  tracked: Tracked,
  step: CommandStep | AgentStep,
  start: StepStart,
  activity: (secret: string) => (activity: HarnessActivity) => void,
) {
  if (step.kind === "command") {
    return startCommandStep(options.executor, step, start.context, start.attempt);
  }
  return startAgentStep(
    {
      executor: options.executor,
      adapters: options.adapters ?? DEFAULT_HARNESS_ADAPTERS,
      loopfileRoot: owner.paths.loopfile,
      events: tracked.log,
      attemptsFolder: owner.paths.attempts,
      inputsFolder: owner.paths.inputs,
      loopfileName: start.loopfileName,
      workflow,
      history: () => tracked.history,
      onActivity: activity(start.context.attemptSecret),
    },
    step,
    start.context,
    start.attempt,
    start.startedAt,
    workflow.steps,
  );
}

/** Waits for the process under the step's own `timeout`, and gives the attempt end. */
async function waitForEnd(
  started: { cancel(): void; readonly ended: Promise<{ exit: Ended } | { ended: Ended }> },
  step: CommandStep | AgentStep,
  tracked: Tracked,
  attemptId: string,
): Promise<AttemptEndFields> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    started.cancel();
  }, step.timeoutMs);
  const finished = await started.ended;
  clearTimeout(timer);
  const exit = "exit" in finished ? finished.exit : finished.ended;
  return timedOut ? TIMEOUT_END : endOfAttempt(step, tracked.history, attemptId, exit);
}

/** One activity router for each secret, so a Ralph iteration's data stays its own. */
function activityFor(owner: RunOwner, tracked: Tracked, attemptId: string) {
  const routers = new Map<string, (activity: HarnessActivity) => void>();
  return (secret: string) => {
    let router = routers.get(secret);
    if (router === undefined) {
      router = harnessActivityRouter({
        activityPath: owner.paths.activity,
        attemptId,
        secrets: { attemptSecret: secret },
        status: tracked.status,
        events: () => tracked.history,
        onData: (data) => {
          tracked.harnessData = data;
        },
      });
      routers.set(secret, router);
    }
    return router;
  };
}

interface RalphRun {
  readonly options: ExecuteRunOptions;
  readonly adapters: HarnessAdapters;
  readonly owner: RunOwner;
  readonly workflow: Workflow;
  readonly tracked: Tracked;
  readonly start: StepStart;
  readonly activity: (secret: string) => (activity: HarnessActivity) => void;
}

/** A Ralph attempt: its iterations own their processes, timers and secrets. */
async function runRalph(run: RalphRun, step: RalphStep): Promise<AttemptEndFields> {
  const { start, tracked } = run;
  let latest = start.context.attemptSecret;
  // The iterations start their own processes, so no one group is the attempt's.
  await start.onProcess(0);
  const result = await runRalphStep(
    {
      executor: run.options.executor,
      adapters: run.adapters,
      loopfileRoot: run.owner.paths.loopfile,
      events: tracked.log,
      attemptsFolder: run.owner.paths.attempts,
      inputsFolder: run.owner.paths.inputs,
      loopfileName: run.start.loopfileName,
      workflow: run.workflow,
      history: () => tracked.history,
      onActivity: (activity) => run.activity(latest)(activity),
      stopSignal: start.stopSignal,
      newSecret: () => {
        latest = randomBytes(16).toString("hex");
        return latest;
      },
      setCurrent: start.setCurrent,
    },
    step,
    start.context,
    start.attempt,
    start.startedAt,
    run.workflow.steps,
  );
  if ("kind" in result) return START_FAILED_END;
  const { iterations: _iterations, ...ralphEnd } = result;
  return ralphEnd;
}

/** Routes an attempt call to the handler that answers it. */
function dispatch(tracked: Tracked, owner: RunOwner, step: Step): AttemptCallHandler {
  const history = () => tracked.history;
  const result = resultHandler({
    events: tracked.log,
    allowedOutcomes: Object.keys(step.on),
    history,
  });
  const put = dataPutHandler({
    events: tracked.log,
    attemptsFolder: owner.paths.attempts,
    history,
  });
  const get = dataGetHandler({
    events: tracked.log,
    attemptsFolder: owner.paths.attempts,
    inputsFolder: owner.paths.inputs,
    history,
  });
  return (call) => {
    if (call.argv[0] === "result") return result(call);
    if (call.argv[0] === "data" && call.argv[1] === "get") return get(call);
    return put(call);
  };
}

interface Tracked {
  readonly log: EventLog;
  readonly history: RunEvent[];
  readonly status: StatusWriter;
  harnessData: HarnessData;
}

/** An event log that also keeps every event it wrote, and tells the status writer about each. */
function tracking(log: EventLog, history: RunEvent[], status: StatusWriter): Tracked {
  return {
    history,
    status,
    harnessData: NO_HARNESS_DATA,
    log: {
      async append(event) {
        const written = await log.append(event);
        history.push(written);
        await status.onEvent(history);
        return written;
      },
      close: () => log.close(),
    },
  };
}

/** The end of an attempt that a step's own `timeout` cut short. */
const TIMEOUT_END: AttemptEndFields = { result: "failure", reason: "timeout" };

/** What cut an attempt short: the run timeout, a cancel, or an interrupt. */
type StopReason = "run_timeout" | "cancel" | "interrupt";

type Running = Extract<StartResult, { kind: "running" }>;

interface AttemptGuard {
  /** The executor the attempt starts its processes through. */
  readonly executor: Executor;
  /** What cut the attempt short, if anything did. */
  stoppedBy(): StopReason | undefined;
  /**
   * Settles once no process group the attempt started has a process left:
   * the executor sends SIGKILL after `CANCEL_GRACE_MS`, so it does not wait
   * much longer than that.
   */
  drained(): Promise<void>;
  clear(): void;
}

/**
 * Stops one attempt when the run timeout passes (D1) or a cancel comes (#63):
 * every process the attempt started gets SIGTERM, then SIGKILL, and the
 * attempt starts no more, so a Ralph step does not begin its next iteration.
 * With no `runTimeout` set, nothing is timed.
 */
function attemptGuard(
  workflow: Workflow,
  history: readonly RunEvent[],
  executor: Executor,
  cancelled: AbortSignal,
  interrupted: AbortSignal,
): AttemptGuard {
  let stoppedBy: StopReason | undefined;
  const running: Running[] = [];
  const stop = (reason: StopReason) => {
    stoppedBy ??= reason;
    for (const started of running) started.cancel();
  };
  const timer = runTimeoutTimer(workflow, history, () => stop("run_timeout"));
  const onCancel = () => stop("cancel");
  const onInterrupt = () => stop("interrupt");
  cancelled.addEventListener("abort", onCancel, { once: true });
  interrupted.addEventListener("abort", onInterrupt, { once: true });
  if (cancelled.aborted) onCancel();
  if (interrupted.aborted) onInterrupt();
  return {
    stoppedBy: () => stoppedBy,
    drained: () => groupsGone(running.map((started) => started.processGroupId)),
    clear: () => {
      clearTimeout(timer);
      cancelled.removeEventListener("abort", onCancel);
      interrupted.removeEventListener("abort", onInterrupt);
    },
    executor: {
      async start(request): Promise<StartResult> {
        if (stoppedBy !== undefined) return { kind: "start-failed", message: STOPPED[stoppedBy] };
        const started = await executor.start(request);
        if (started.kind !== "running") return started;
        running.push(started);
        // A stop that came while the process was starting has not reached it yet.
        if (stoppedBy !== undefined) started.cancel();
        return started;
      },
    },
  };
}

const STOPPED: Readonly<Record<StopReason, string>> = {
  run_timeout: "the run timeout has passed",
  cancel: "the run was cancelled",
  interrupt: "the attempt was interrupted",
};

/** A timer for the run owner time that is left, or none when the run has no `runTimeout`. */
function runTimeoutTimer(
  workflow: Workflow,
  history: readonly RunEvent[],
  fire: () => void,
): NodeJS.Timeout | undefined {
  if (workflow.runTimeoutMs === undefined) return undefined;
  return setTimeout(fire, Math.max(0, workflow.runTimeoutMs - replay(history).ownerTimeMs));
}

/** How much longer than the SIGKILL grace `groupsGone` waits for the kernel. */
const DRAIN_SLACK_MS = 5_000;

/** Waits until none of `groups` has a process, or the grace and some slack have passed. */
async function groupsGone(groups: readonly number[]): Promise<void> {
  const deadline = Date.now() + CANCEL_GRACE_MS + DRAIN_SLACK_MS;
  while (groups.some(groupAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
