/** The source named by a launch, before local loading or remote fetching. */
export type ParsedSource = LocalSource | RemoteSource;

export interface LocalSource {
  readonly kind: "local";
  readonly source: string;
}

export interface RemoteSource {
  readonly kind: "remote";
  readonly host: "github.com";
  readonly repo: string;
  readonly url: string;
  readonly path?: string;
  readonly ref?: string;
  readonly bareSource?: string;
}

/** Parses explicit GitHub sources and, when absent locally, bare owner/repo sources. */
export function parseSource(text: string, exists: boolean): ParsedSource {
  if (text.startsWith("github:")) return parseExplicitSource(text);
  return exists ? { kind: "local", source: text } : parseBareSource(text);
}

function parseExplicitSource(text: string): ParsedSource {
  const match = /^github:([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)(.*)$/.exec(text);
  if (match === null) return { kind: "local", source: text };
  const suffix = parseRemoteSuffix(match[3] ?? "");
  if (suffix === undefined) return { kind: "local", source: text };
  return githubSource(match[1] ?? "", match[2] ?? "", suffix);
}

function parseBareSource(text: string): ParsedSource {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)(.*)$/.exec(text);
  if (match === null || match[2] === "." || match[2] === "..") {
    return { kind: "local", source: text };
  }
  const suffix = parseBareSuffix(match[3] ?? "");
  if (suffix === undefined) return { kind: "local", source: text };
  return { ...githubSource(match[1] ?? "", match[2] ?? "", suffix), bareSource: text };
}

function githubSource(
  owner: string,
  repository: string,
  suffix: Pick<RemoteSource, "path" | "ref">,
): RemoteSource {
  const repo = `${owner}/${repository}`.toLowerCase();
  return { kind: "remote", host: "github.com", repo, url: `https://github.com/${repo}`, ...suffix };
}

function parseRemoteSuffix(suffix: string): Pick<RemoteSource, "path" | "ref"> | undefined {
  if (unsupportedSuffix(suffix)) return undefined;
  const { path, ref } = pathAndRef(suffix);
  if (hasInvalidPathSegment(path)) throw new Error(`invalid path segment in ${path}`);
  return { ...(path === "" ? {} : { path }), ...(ref === undefined ? {} : { ref }) };
}

function parseBareSuffix(suffix: string): Pick<RemoteSource, "path" | "ref"> | undefined {
  const at = suffix.lastIndexOf("@");
  const pathText = at < 0 ? suffix : suffix.slice(0, at);
  const ref = at < 0 ? undefined : suffix.slice(at + 1);
  if (ref === "") return undefined;
  const path = parseBarePath(pathText);
  if (path === undefined) return undefined;
  return bareSuffix(path, ref);
}

function bareSuffix(path: string, ref: string | undefined): Pick<RemoteSource, "path" | "ref"> {
  return { ...(path === "" ? {} : { path }), ...(ref === undefined ? {} : { ref }) };
}

function parseBarePath(pathText: string): string | undefined {
  if (pathText === "") return "";
  if (!pathText.startsWith("/") || pathText === "/") return undefined;
  const path = pathText.slice(1);
  return hasInvalidPathSegment(path) ? undefined : path;
}

function unsupportedSuffix(suffix: string): boolean {
  return suffix !== "" && !suffix.startsWith("/") && !suffix.startsWith("@");
}

function pathAndRef(suffix: string): { readonly path: string; readonly ref: string | undefined } {
  const at = suffix.lastIndexOf("@");
  return {
    path: normalizePath(at < 0 ? suffix : suffix.slice(0, at)),
    ref: at < 0 ? undefined : suffix.slice(at + 1),
  };
}

function normalizePath(path: string): string {
  return path.replace(/^\//, "").replace(/^\/+|\/+$/g, "");
}

function hasInvalidPathSegment(path: string): boolean {
  return (
    path !== "" &&
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}
