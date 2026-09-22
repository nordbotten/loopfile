/**
 * Pure rules for filling `{{ <data key> }}` placeholders in a prompt (#168,
 * ADR 0003, ADR 0005). Which files hold a key's value and how they are read
 * is `src/adapters/prompt-fill.ts`'s work; this module decides only the text.
 */

import Handlebars from "handlebars/dist/cjs/handlebars.js";
import type { RunEvent } from "../domain/events.ts";
import { type GetSource, sourceOfGet } from "./data-store.ts";
import { quotePromptNames } from "./prompt-check.ts";

export type PromptData = string | boolean | number | PromptDataView | readonly PromptData[];

export interface PromptDataView {
  readonly [key: string]: PromptData;
}

interface MutablePromptDataView {
  [key: string]: PromptData;
}

/** Builds Handlebars' nested view from Loopfile's flat data keys. */
export function promptDataView(values: ReadonlyMap<string, PromptData>): PromptDataView {
  const view: MutablePromptDataView = Object.create(null);
  for (const [key, value] of values) {
    const parts = key.split(".");
    const last = parts.pop();
    if (last === undefined) continue;
    let at = view;
    for (const part of parts) {
      const next = at[part];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        const branch: MutablePromptDataView = Object.create(null);
        at[part] = branch;
        at = branch;
      } else at = next as MutablePromptDataView;
    }
    at[last] = value;
  }
  return view;
}

/** Renders one prompt as a Handlebars template without HTML escaping. */
export function renderPrompt(text: string, view: PromptDataView): string {
  return Handlebars.compile(quotePromptNames(text), { noEscape: true })(
    jsonPromptData(view) as PromptDataView,
  );
}

/** Makes a list or map render as stable, indented JSON when used as a value. */
function jsonPromptData(value: PromptData): PromptData {
  if (Array.isArray(value)) return jsonValue(value.map(jsonPromptData));
  if (typeof value !== "object" || value === null) return value;
  return jsonValue(
    Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonPromptData(child)])),
  );
}

function jsonValue<T extends object>(value: T): T {
  Object.defineProperty(value, "toString", {
    enumerable: false,
    value: () => JSON.stringify(value, null, 2),
  });
  return value;
}

export interface HistoryEntry extends PromptDataView {
  readonly value: string;
  readonly attemptId: string;
  readonly outcome: string;
  readonly index: number;
  readonly newest: boolean;
  readonly new: boolean;
}

/** Makes the `$history.<key>` entries from the sources and bytes its prompt read. */
export function historyEntries(
  history: readonly RunEvent[],
  stepId: string,
  attemptId: string,
  key: string,
  sources: readonly GetSource[],
  values: readonly (string | undefined)[],
): readonly HistoryEntry[] {
  const lastAttempt = history.findLast(
    (event) =>
      event.type === "attempt.started" && event.stepId === stepId && event.attemptId !== attemptId,
  );
  return sources.map((source, offset) =>
    historyEntry(history, key, source, values[offset], offset, sources.length, lastAttempt?.seq),
  );
}

function historyEntry(
  history: readonly RunEvent[],
  key: string,
  source: GetSource,
  value: string | undefined,
  offset: number,
  length: number,
  lastAttemptSeq: number | undefined,
): HistoryEntry {
  const attempt = attemptSource(source);
  return {
    value: value ?? "",
    attemptId: attemptIdOf(attempt),
    outcome: attemptOutcome(history, attempt),
    index: offset + 1,
    newest: offset === length - 1,
    new: isNew(history, key, attempt, lastAttemptSeq),
  };
}

function attemptSource(source: GetSource): Extract<GetSource, { kind: "attempt" }> | undefined {
  return source.kind === "attempt" ? source : undefined;
}

function attemptIdOf(source: Extract<GetSource, { kind: "attempt" }> | undefined): string {
  return source?.attemptId ?? "";
}

function attemptOutcome(
  history: readonly RunEvent[],
  source: Extract<GetSource, { kind: "attempt" }> | undefined,
): string {
  return source === undefined ? "" : outcomeOf(history, source.attemptId);
}

function isNew(
  history: readonly RunEvent[],
  key: string,
  source: Extract<GetSource, { kind: "attempt" }> | undefined,
  lastAttemptSeq: number | undefined,
): boolean {
  if (lastAttemptSeq === undefined) return true;
  return (source === undefined ? 0 : (putOf(history, key, source)?.seq ?? 0)) > lastAttemptSeq;
}

/**
 * Where `key`'s value comes from, oldest first: the input file for `input.*`,
 * the newest put for a key written with `data put`, and every append for a key
 * written with `data append`. Empty when the key has no value.
 */
export function valueSources(history: readonly RunEvent[], key: string): readonly GetSource[] {
  const newest = sourceOfGet(history, key);
  if (newest === undefined) return [];
  if (newest.kind === "input" || !wasAppended(history, key)) return [newest];
  return puts(history, key).map(appendSource);
}

type Put = Extract<RunEvent, { type: "data.put" }>;

/** Every source in a key's value history, oldest first. */
export function historySources(history: readonly RunEvent[], key: string): readonly GetSource[] {
  const input = sourceOfGet([], key);
  if (input?.kind === "input") return [input];
  const keyPuts = puts(history, key);
  return (keyPuts.at(-1)?.appended === true ? keyPuts : lastPlainPuts(keyPuts)).map(appendSource);
}

function puts(history: readonly RunEvent[], key: string): Put[] {
  return history.filter((e): e is Put => e.type === "data.put" && e.key === key);
}

/** A plain put overwrites its attempt's one value file, so only its last put survives. */
function lastPlainPuts(keyPuts: readonly Put[]): Put[] {
  const latest = new Map<string, Put>();
  for (const put of keyPuts) latest.set(put.attemptId, put);
  return [...latest.values()];
}

function wasAppended(history: readonly RunEvent[], key: string): boolean {
  return puts(history, key).at(-1)?.appended === true;
}

function putOf(
  history: readonly RunEvent[],
  key: string,
  source: Extract<GetSource, { kind: "attempt" }>,
): Put | undefined {
  return history.findLast(
    (event): event is Put =>
      event.type === "data.put" &&
      event.key === key &&
      event.attemptId === source.attemptId &&
      event.writeIndex === source.writeIndex,
  );
}

function outcomeOf(history: readonly RunEvent[], attemptId: string): string {
  const end = history.find(
    (event) => event.type === "attempt.ended" && event.attemptId === attemptId,
  );
  return end?.type === "attempt.ended" ? (end.outcome ?? "") : "";
}

function appendSource(put: Put): GetSource {
  return {
    kind: "attempt",
    attemptId: put.attemptId,
    ...(put.writeIndex === undefined ? {} : { writeIndex: put.writeIndex }),
  };
}
