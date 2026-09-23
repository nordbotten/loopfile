import { parseDocument } from "yaml";

export interface TrustList {
  readonly repos: readonly string[];
  readonly owners: readonly string[];
}

export type TrustListResult =
  | ({ readonly status: "ok" } & TrustList)
  | { readonly status: "broken"; readonly reason: string };

/** Parses an operator trust list without reading or writing files. */
export function parseTrustList(text: string | undefined): TrustListResult {
  if (text === undefined) return { status: "ok", repos: [], owners: [] };

  const document = parseDocument(text);
  if (document.errors[0] !== undefined) {
    return { status: "broken", reason: document.errors[0].message };
  }

  try {
    return parseTrustValue(document.toJS());
  } catch (error) {
    return { status: "broken", reason: (error as Error).message };
  }
}

function parseTrustValue(value: unknown): TrustListResult {
  if (!isRecord(value)) return { status: "broken", reason: "trust list must be a map" };
  for (const key of Object.keys(value)) {
    if (key !== "formatVersion" && key !== "repos" && key !== "owners") {
      return { status: "broken", reason: `unknown top-level key: ${key}` };
    }
  }
  if (value.formatVersion !== 1) {
    return { status: "broken", reason: "formatVersion must be 1" };
  }

  const repos = readEntries(value.repos, "repos");
  if (typeof repos === "string") return { status: "broken", reason: repos };
  const owners = readEntries(value.owners, "owners");
  if (typeof owners === "string") return { status: "broken", reason: owners };
  return { status: "ok", repos, owners };
}

/** Matches the lowercase host/repository key used by every remote transport. */
export function matchesTrust(trust: TrustList, key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    trust.repos.includes(normalizedKey) ||
    trust.owners.some((owner) => normalizedKey.startsWith(`${owner}/`))
  );
}

function readEntries(value: unknown, name: string): readonly string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return `${name} must be a list`;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") return `${name}[${index}] must be a string`;
  }
  return value.map((entry: string) => entry.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
