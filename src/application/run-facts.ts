import type { RunEvent } from "../domain/events.ts";
import type { AttemptId, Step, StepId, Workflow } from "../domain/model.ts";
import type { PromptDataView } from "./prompt-fill.ts";

export interface RunFacts extends PromptDataView {
  readonly runId: string;
  readonly loopfileName: string;
  readonly startedAt: string;
  readonly targetFolder: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly transitions: number;
  readonly maxTransitions: number | "";
  readonly runTimeout: string;
  readonly attempts: readonly EarlierAttemptFacts[];
  readonly attempt: AttemptFacts;
  readonly previous: "" | PreviousFacts;
}

export interface PreviousFacts extends PromptDataView {
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  readonly outcome: string;
  readonly message: string;
  readonly reason: string;
  readonly data: PreviousData;
}

export interface PreviousData extends PromptDataView {
  readonly [stepId: string]: PromptDataView;
}

export interface EarlierAttemptFacts extends PromptDataView {
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  readonly number: number;
  readonly result: "success" | "failure" | "";
  readonly reason: string;
  readonly outcome: string;
  readonly message: string;
  readonly startedAt: string;
  readonly index: number;
  readonly newest: boolean;
}

export interface AttemptFacts extends PromptDataView {
  readonly id: AttemptId;
  readonly number: number;
  readonly startedAt: string;
  readonly maxAttempts: number | "";
  readonly timeout: string;
  readonly lastAttempt: boolean;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly lastIteration: boolean;
  readonly previousIteration: "" | PreviousIterationFacts;
}

export interface PreviousIterationFacts extends PromptDataView {
  readonly number: number;
  readonly reason: "no_outcome" | "timeout" | "nonzero_exit";
}

/** Builds the current attempt's prompt data from its prior events and manifest step. */
export function runFacts(
  history: readonly RunEvent[],
  step: Step,
  current: {
    readonly attemptId: AttemptId;
    readonly stepId: StepId;
    readonly startedAt: string;
    readonly iteration?: number;
  },
  loopfileName = "",
  steps: readonly Step[] = [step],
  workflow?: Pick<Workflow, "maxTransitions" | "declaredRunTimeout">,
): RunFacts {
  return {
    ...runDetails(history, loopfileName),
    ...runLimits(history, workflow),
    attempts: earlierAttempts(history, current.attemptId),
    attempt: attemptFacts(history, step, current),
    previous: previousFacts(history, current.stepId, steps),
  };
}

interface RunDetails {
  readonly runId: string;
  readonly loopfileName: string;
  readonly startedAt: string;
  readonly targetFolder: string;
  readonly branch: string;
  readonly baseCommit: string;
}

type Created = Extract<RunEvent, { type: "run.created" }>;

function runDetails(history: readonly RunEvent[], loopfileName: string): RunDetails {
  const created = history.find((event): event is Created => event.type === "run.created");
  return { ...runIdentity(created, loopfileName), ...runLocation(created) };
}

function runIdentity(created: Created | undefined, loopfileName: string) {
  return {
    runId: created?.runId ?? "",
    loopfileName,
    startedAt: created?.at ?? "",
  };
}

function runLocation(created: Created | undefined) {
  return {
    targetFolder: created?.targetFolder ?? "",
    branch: created?.branch ?? "",
    baseCommit: created?.baseCommit ?? "",
  };
}

function runLimits(
  history: readonly RunEvent[],
  workflow: Pick<Workflow, "maxTransitions" | "declaredRunTimeout"> | undefined,
) {
  return {
    transitions: history.filter((event) => event.type === "transition").length,
    maxTransitions: workflow?.maxTransitions ?? ("" as const),
    runTimeout: workflow?.declaredRunTimeout ?? "",
  };
}

function earlierAttempts(
  history: readonly RunEvent[],
  currentAttemptId: AttemptId,
): readonly EarlierAttemptFacts[] {
  const started = history.filter(
    (event): event is AttemptStarted =>
      event.type === "attempt.started" && event.attemptId !== currentAttemptId,
  );
  return started.map((attempt, offset) => earlierAttempt(history, attempt, offset, started.length));
}

function earlierAttempt(
  history: readonly RunEvent[],
  attempt: AttemptStarted,
  offset: number,
  length: number,
): EarlierAttemptFacts {
  const ended = attemptEnd(history, attempt.attemptId);
  return {
    stepId: attempt.stepId,
    attemptId: attempt.attemptId,
    number: attemptNumber(attemptsAtStep(history, attempt.stepId), attempt),
    ...endFacts(ended),
    message: attemptMessage(history, attempt.attemptId),
    startedAt: attempt.at,
    index: offset + 1,
    newest: offset === length - 1,
  };
}

function attemptEnd(history: readonly RunEvent[], attemptId: AttemptId) {
  return history.find(
    (event): event is Extract<RunEvent, { type: "attempt.ended" }> =>
      event.type === "attempt.ended" && event.attemptId === attemptId,
  );
}

function endFacts(
  ended: Extract<RunEvent, { type: "attempt.ended" }> | undefined,
): Pick<EarlierAttemptFacts, "result" | "reason" | "outcome"> {
  return {
    result: ended?.result ?? "",
    reason: ended?.reason ?? "",
    outcome: ended?.outcome ?? "",
  };
}

function attemptMessage(history: readonly RunEvent[], attemptId: AttemptId): string {
  return (
    history.findLast(
      (event): event is Extract<RunEvent, { type: "outcome.reported" }> =>
        event.type === "outcome.reported" && event.attemptId === attemptId,
    )?.message ?? ""
  );
}

function previousFacts(
  history: readonly RunEvent[],
  stepId: StepId,
  steps: readonly Step[],
): "" | PreviousFacts {
  const transition = history.findLast(
    (event): event is Extract<RunEvent, { type: "transition" }> =>
      event.type === "transition" && event.to === stepId,
  );
  if (transition === undefined) return "";
  const step = steps.find((candidate) => candidate.id === transition.from);
  return {
    stepId: transition.from,
    attemptId: transition.attemptId,
    outcome: transition.reason === "outcome" ? (transition.outcome ?? "") : "",
    message: previousMessage(history, transition),
    reason: transition.reason === "outcome" ? "" : transition.reason,
    data: previousData(step),
  };
}

function previousMessage(
  history: readonly RunEvent[],
  transition: Extract<RunEvent, { type: "transition" }>,
): string {
  if (transition.reason !== "outcome") return "";
  return (
    history.findLast(
      (event): event is Extract<RunEvent, { type: "outcome.reported" }> =>
        event.type === "outcome.reported" && event.attemptId === transition.attemptId,
    )?.message ?? ""
  );
}

function previousData(step: Step | undefined): PreviousData {
  return {
    ...(step === undefined
      ? {}
      : {
          [step.id]: Object.fromEntries(Object.keys(step.outputs).map((output) => [output, ""])),
        }),
  };
}

function attemptFacts(
  history: readonly RunEvent[],
  step: Step,
  current: {
    readonly attemptId: AttemptId;
    readonly stepId: StepId;
    readonly startedAt: string;
    readonly iteration?: number;
  },
): AttemptFacts {
  const attempts = attemptsAtStep(history, current.stepId);
  const started = attempts.find((event) => event.attemptId === current.attemptId);
  const number = attemptNumber(attempts, started);
  return {
    id: current.attemptId,
    number,
    startedAt: started?.at ?? current.startedAt,
    maxAttempts: step.declaredLimits?.maxAttempts ?? "",
    timeout: step.declaredLimits?.timeout ?? "",
    lastAttempt: number === step.maxAttempts,
    ...iterationFacts(history, step, current.attemptId, current.iteration),
  };
}

function iterationFacts(
  history: readonly RunEvent[],
  step: Step,
  attemptId: AttemptId,
  current = 1,
): Pick<AttemptFacts, "iteration" | "maxIterations" | "lastIteration" | "previousIteration"> {
  const maxIterations = step.kind === "ralph" ? step.maxIterations : 1;
  return {
    iteration: current,
    maxIterations,
    lastIteration: current === maxIterations,
    previousIteration: previousIteration(history, attemptId, current),
  };
}

function previousIteration(
  history: readonly RunEvent[],
  attemptId: AttemptId,
  iteration: number,
): "" | PreviousIterationFacts {
  if (iteration === 1) return "";
  const ended = history.find(
    (
      event,
    ): event is Extract<RunEvent, { type: "iteration.ended" }> & {
      readonly reason: PreviousIterationFacts["reason"];
    } =>
      event.type === "iteration.ended" &&
      event.attemptId === attemptId &&
      event.iteration === iteration - 1 &&
      event.reason !== "outcome",
  );
  return ended === undefined ? "" : { number: ended.iteration, reason: ended.reason };
}

type AttemptStarted = Extract<RunEvent, { type: "attempt.started" }>;

function attemptsAtStep(history: readonly RunEvent[], stepId: StepId): readonly AttemptStarted[] {
  return history.filter(
    (event): event is AttemptStarted => event.type === "attempt.started" && event.stepId === stepId,
  );
}

function attemptNumber(
  attempts: readonly AttemptStarted[],
  started: AttemptStarted | undefined,
): number {
  return started === undefined ? attempts.length + 1 : attempts.indexOf(started) + 1;
}
