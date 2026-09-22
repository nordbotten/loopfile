/**
 * Fills a prompt's `{{ <data key> }}` placeholders before one harness call
 * (#168, #268, ADR 0003, ADR 0005). The rules are in
 * `application/prompt-fill.ts`; this file reads value files and records the
 * fill as `prompt.filled`. A fill writes no `data.get`: `prompt.filled` is the
 * record of the read.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GetSource, sha256 } from "../application/data-store.ts";
import { checkPrompt, HISTORY_ROOT } from "../application/prompt-check.ts";
import {
  historyEntries,
  historySources,
  type PromptData,
  promptDataView,
  renderPrompt,
  valueSources,
} from "../application/prompt-fill.ts";
import { runFacts } from "../application/run-facts.ts";
import type { RunEvent } from "../domain/events.ts";
import type { AttemptId, Step, StepId, Workflow } from "../domain/model.ts";
import { dataFile } from "./data-store.ts";
import type { EventLog } from "./event-log.ts";

export interface PromptFillOptions {
  readonly events: Pick<EventLog, "append">;
  /** The run's events so far, oldest first. */
  history(): readonly RunEvent[];
  readonly attemptsFolder: string;
  /** `RunPaths.inputs`: where the run's launch inputs sit (#82). */
  readonly inputsFolder: string;
  /** The name recorded in the run status projection. */
  readonly loopfileName?: string;
  /** The workflow's run limits. */
  readonly workflow?: Workflow;
}

export interface PromptFillCall {
  readonly attemptId: AttemptId;
  readonly stepId: StepId;
  /** The clock time at which this attempt began, before its start event is logged. */
  readonly startedAt: string;
  /** The manifest step whose prompt is being filled. */
  readonly step?: Step;
  /** The workflow's steps, used to find the prior step's declared outputs. */
  readonly steps?: readonly Step[];
  /** Only on a Ralph step. */
  readonly iteration?: number;
}

/**
 * The prompt with each placeholder filled. A prompt with no placeholders reads
 * no data, so it is returned as is and no event is appended (D2).
 */
export async function fillPromptForCall(
  options: PromptFillOptions,
  call: PromptFillCall,
  text: string,
): Promise<string> {
  const names = promptNames(text);
  if (names.length === 0) return text;

  const data = await promptValues(options, call, names);
  const filled = renderPrompt(text, promptDataView(data.values));
  const content = Buffer.from(filled, "utf8");
  await options.events.append(promptFilledEvent(call, names, data, content));
  return filled;
}

function promptFilledEvent(
  call: PromptFillCall,
  names: readonly PromptName[],
  data: PromptValues,
  content: Buffer,
) {
  return {
    type: "prompt.filled" as const,
    attemptId: call.attemptId,
    stepId: call.stepId,
    ...(call.iteration === undefined ? {} : { iteration: call.iteration }),
    keys: promptKeys(names, data),
    ...promptReads(data),
    size: content.byteLength,
    digest: sha256(content),
  };
}

function promptKeys(names: readonly PromptName[], data: PromptValues): Record<string, boolean> {
  const keys = new Set(names.filter((name) => !name.run).map(({ key }) => key));
  return Object.fromEntries(
    [...keys].map((key) => [key, hasValue(data.values, key) || data.historyValues.has(key)]),
  );
}

function promptReads(data: PromptValues) {
  if (data.historyReads.size === 0 && data.runReads.size === 0) return {};
  return {
    reads: {
      ...(data.historyReads.size === 0 ? {} : { values: Object.fromEntries(data.historyReads) }),
      ...(data.runReads.size === 0 ? {} : { run: [...data.runReads] }),
    },
  };
}

interface PromptName {
  readonly key: string;
  readonly history: boolean;
  readonly run: boolean;
  readonly blockItem: boolean;
  readonly read?: string;
}

/** The data keys a checked prompt reads. */
function promptNames(text: string): readonly PromptName[] {
  const checked = checkPrompt(text);
  // The loader checked this same materialized prompt before any call starts.
  if (checked.status === "invalid") return [];
  return checked.reads.flatMap<PromptName>((read) => {
    if (read.name === "" || read.name.startsWith("@")) return [];
    const fullName = [...read.scope, read.name].filter((part) => part !== "").join(".");
    if (fullName === "$run" || fullName.startsWith("$run.")) {
      return [{ key: "$run", history: false, run: true, blockItem: false, read: fullName }];
    }
    if (read.scope[0] === HISTORY_ROOT) {
      return [{ key: read.scope.slice(1).join("."), history: true, run: false, blockItem: false }];
    }
    if (read.name.startsWith(`${HISTORY_ROOT}.`)) {
      return [
        {
          key: read.name.slice(HISTORY_ROOT.length + 1),
          history: true,
          run: false,
          blockItem: read.blockItem === true,
        },
      ];
    }
    return [
      {
        key: [...read.scope, read.name].filter((part) => part !== "").join("."),
        history: false,
        run: false,
        blockItem: read.blockItem === true,
      },
    ];
  });
}

interface PromptValues {
  readonly values: Map<string, PromptData>;
  readonly historyReads: Map<string, readonly GetSource[]>;
  readonly historyValues: Set<string>;
  readonly runReads: Set<string>;
}

/** Reads every available prompt value. */
async function promptValues(
  options: PromptFillOptions,
  call: PromptFillCall,
  names: readonly PromptName[],
): Promise<PromptValues> {
  const history = options.history();
  const values = await regularPromptValues(options, history, names);
  const { historyReads, historyValues } = await historyPromptValues(
    options,
    call,
    history,
    names,
    values,
  );
  const runReads = new Set(names.filter((name) => name.run).flatMap((name) => name.read ?? []));
  if (runReads.size > 0) {
    const step = call.step;
    if (step === undefined) throw new Error("a $run prompt needs its manifest step");
    values.set("$run", await promptRunFacts(options, history, { ...call, step }));
  }
  return { values, historyReads, historyValues, runReads };
}

type Values = Map<string, PromptData>;

async function promptRunFacts(
  options: PromptFillOptions,
  history: readonly RunEvent[],
  call: PromptFillCall & { readonly step: Step },
): Promise<PromptData> {
  const facts = runFacts(
    history,
    call.step,
    call,
    options.loopfileName,
    call.steps,
    options.workflow,
  );
  const previous = facts.previous;
  if (previous === "") return facts;
  const data = Object.fromEntries(
    await Promise.all(
      Object.entries(previous.data).map(async ([stepId, outputs]) => [
        stepId,
        Object.fromEntries(
          await Promise.all(
            Object.keys(outputs).map(async (output) => [
              output,
              (
                await readParts(
                  options,
                  attemptSources(history, previous.attemptId, `${stepId}.${output}`),
                  `${stepId}.${output}`,
                )
              ).join("\n"),
            ]),
          ),
        ),
      ]),
    ),
  );
  return { ...facts, previous: { ...previous, data } };
}

function attemptSources(
  history: readonly RunEvent[],
  attemptId: AttemptId,
  key: string,
): readonly GetSource[] {
  const puts = history.filter(
    (event): event is Extract<RunEvent, { type: "data.put" }> =>
      event.type === "data.put" && event.attemptId === attemptId && event.key === key,
  );
  const last = puts.at(-1);
  if (last === undefined) return [];
  const sources = last.appended ? puts : [last];
  return sources.map((put) => ({
    kind: "attempt",
    attemptId,
    ...(put.writeIndex === undefined ? {} : { writeIndex: put.writeIndex }),
  }));
}

async function regularPromptValues(
  options: PromptFillOptions,
  history: readonly RunEvent[],
  names: readonly PromptName[],
): Promise<Values> {
  const regular = names.filter((name) => !name.history && !name.run);
  const keys = await regularKeys(options.inputsFolder, history, regular);
  const values: Values = new Map();
  for (const key of keys) {
    const parts = await readParts(options, valueSources(history, key), key);
    if (parts.length > 0) values.set(key, parts.join("\n"));
  }
  return values;
}

async function regularKeys(
  inputsFolder: string,
  history: readonly RunEvent[],
  names: readonly PromptName[],
): Promise<Set<string>> {
  const keys = new Set(
    names.flatMap(({ key, blockItem }) => (blockItem ? [key, ...keysUnder(history, key)] : [key])),
  );
  for (const { key, blockItem } of names) {
    if (blockItem) for (const child of await inputKeys(inputsFolder, key)) keys.add(child);
  }
  return keys;
}

async function historyPromptValues(
  options: PromptFillOptions,
  call: PromptFillCall,
  history: readonly RunEvent[],
  names: readonly PromptName[],
  values: Values,
): Promise<Pick<PromptValues, "historyReads" | "historyValues">> {
  const historyReads = new Map<string, readonly GetSource[]>();
  const historyValues = new Set<string>();
  for (const key of new Set(names.filter((name) => name.history).map((name) => name.key))) {
    await addHistoryPromptValue(options, call, history, key, values, historyReads, historyValues);
  }
  return { historyReads, historyValues };
}

async function addHistoryPromptValue(
  options: PromptFillOptions,
  call: PromptFillCall,
  history: readonly RunEvent[],
  key: string,
  values: Values,
  reads: Map<string, readonly GetSource[]>,
  present: Set<string>,
): Promise<void> {
  const sources = historySources(history, key);
  const parts = await Promise.all(sources.map((source) => readSource(options, source, key)));
  if (parts.some((part) => part !== undefined)) present.add(key);
  values.set(
    `${HISTORY_ROOT}.${key}`,
    historyEntries(history, call.stepId, call.attemptId, key, sources, parts),
  );
  reads.set(key, sources);
}

function keysUnder(history: readonly RunEvent[], prefix: string): readonly string[] {
  const marker = `${prefix}.`;
  return [
    ...new Set(
      history.flatMap((event) =>
        event.type === "data.put" || event.type === "data.get" ? [event.key] : [],
      ),
    ),
  ].filter((key) => key.startsWith(marker));
}

function hasValue(values: ReadonlyMap<string, unknown>, key: string): boolean {
  return values.has(key) || [...values.keys()].some((valueKey) => valueKey.startsWith(`${key}.`));
}

async function inputKeys(inputsFolder: string, prefix: string): Promise<readonly string[]> {
  if (prefix !== "input") return [];
  const files = await readdir(inputsFolder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return files.map((file) => `input.${file}`);
}

/** The text of each source that has a file. A missing file is no value. */
async function readParts(
  options: PromptFillOptions,
  sources: readonly GetSource[],
  key: string,
): Promise<string[]> {
  const parts: string[] = [];
  for (const source of sources) {
    const content = await readSource(options, source, key);
    if (content !== undefined) parts.push(content);
  }
  return parts;
}

async function readSource(
  options: PromptFillOptions,
  source: GetSource,
  key: string,
): Promise<string | undefined> {
  const path =
    source.kind === "input"
      ? join(options.inputsFolder, source.name)
      : dataFile(options.attemptsFolder, source.attemptId, key, source.writeIndex);
  return await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
