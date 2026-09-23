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
}

/** Parses the GitHub source form; every other source remains a local path. */
export function parseSource(text: string): ParsedSource {
  const match = /^github:([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)(.*)$/.exec(text);
  if (match === null) return { kind: "local", source: text };
  const suffix = parseRemoteSuffix(match[3] ?? "");
  if (suffix === undefined) return { kind: "local", source: text };
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { kind: "remote", host: "github.com", repo, url: `https://github.com/${repo}`, ...suffix };
}

function parseRemoteSuffix(suffix: string): Pick<RemoteSource, "path" | "ref"> | undefined {
  if (unsupportedSuffix(suffix)) return undefined;
  const { path, ref } = pathAndRef(suffix);
  if (hasInvalidPathSegment(path)) throw new Error(`invalid path segment in ${path}`);
  return { ...(path === "" ? {} : { path }), ...(ref === undefined ? {} : { ref }) };
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
