/** The source named by a launch, before local loading or remote fetching. */
export type ParsedSource = LocalSource | RemoteSource;

export interface LocalSource {
  readonly kind: "local";
  readonly source: string;
}

export interface RemoteSource {
  readonly kind: "remote";
  readonly host: string;
  readonly repo: string;
  /** Fetch-only URL; it may contain credentials and must never be printed or recorded. */
  readonly url: string;
  readonly path?: string;
  readonly ref?: string;
  readonly browserLink?: { readonly kind: "tree" | "blob"; readonly rest: string };
  readonly bareSource?: string;
}

export class SourceParseError extends Error {
  readonly help: string;

  constructor(message: string, help: string) {
    super(message);
    this.name = "SourceParseError";
    this.help = help;
  }
}

/** Parses remote sources before checking local paths, which are always remote. */
export function parseSource(text: string, exists: boolean): ParsedSource {
  if (text.startsWith("github:")) return parseExplicitSource(text);
  if (/^https:\/\/github\.com(?:\/|[?#]|$)/i.test(text)) return parseGitHubBrowserLink(text);
  if (/^git\+http:\/\//i.test(text)) {
    throw new SourceParseError(
      "git+http sources are not accepted",
      "Use git+https:// so the content cannot be changed in transit.",
    );
  }
  if (/^git\+file:\/\//i.test(text)) {
    throw new SourceParseError("git+file sources are not accepted", "Use the local path.");
  }
  if (/^[^/@\s]+@[^/:\s]+:/.test(text)) {
    throw new SourceParseError(
      "scp-style Git sources are not accepted",
      "Write it as git+ssh://user@host/org/repo.",
    );
  }
  if (isRefusedBrowserHost(text)) {
    throw new SourceParseError(
      "plain HTTPS links to this Git host are not accepted",
      "Use git+https://<host>/<org>/<repo>[@ref][#subdirectory=path].",
    );
  }
  if (/^git\+/i.test(text)) return parseGitVcsSource(text);
  return exists ? { kind: "local", source: text } : parseBareSource(text);
}

function isRefusedBrowserHost(text: string): boolean {
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      (url.hostname.toLowerCase() === "gitlab.com" ||
        url.hostname.toLowerCase() === "bitbucket.org")
    );
  } catch {
    return false;
  }
}

const GIT_VCS_HELP =
  "Use git+https:// or git+ssh:// with <host>/<org>/<repo>[@ref][#subdirectory=path].";

interface GitVcsUrl {
  readonly host: string;
  readonly baseUrl: string;
  readonly path: string;
  readonly fragment: string | undefined;
}

interface GitVcsRepository {
  readonly repo: string;
  readonly fetchPath: string;
  readonly ref: string | undefined;
}

function parseGitVcsSource(text: string): RemoteSource {
  const url = parseGitVcsUrl(text);
  const repository = parseGitVcsRepository(url.path);
  const path = parseSubdirectory(url.fragment);
  return {
    kind: "remote",
    host: url.host,
    repo: repository.repo,
    url: url.baseUrl + repository.fetchPath,
    ...(path === undefined ? {} : { path }),
    ...(repository.ref === undefined ? {} : { ref: repository.ref }),
  };
}

function parseGitVcsUrl(text: string): GitVcsUrl {
  const urlText = text.slice(4);
  const fragmentAt = urlText.indexOf("#");
  const baseUrl = fragmentAt < 0 ? urlText : urlText.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? undefined : urlText.slice(fragmentAt + 1);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return invalidGitVcsSource();
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "ssh:") || parsed.search !== "") {
    return invalidGitVcsSource();
  }
  const authorityStart = baseUrl.indexOf("://") + 3;
  const authorityEnd = baseUrl.indexOf("/", authorityStart);
  if (authorityEnd < 0) return invalidGitVcsSource();
  const authority = baseUrl.slice(authorityStart, authorityEnd);
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  return {
    host,
    baseUrl: baseUrl.slice(0, authorityEnd),
    path: baseUrl.slice(authorityEnd),
    fragment,
  };
}

function parseGitVcsRepository(path: string): GitVcsRepository {
  const parts = splitGitVcsRef(path);
  return {
    repo: parseGitRepositoryPath(parts.repoPath),
    fetchPath: parts.fetchPath,
    ref: parts.ref,
  };
}

function splitGitVcsRef(path: string): {
  readonly repoPath: string;
  readonly fetchPath: string;
  readonly ref: string | undefined;
} {
  const at = path.lastIndexOf("@");
  if (at < 0) return { repoPath: path, fetchPath: path, ref: undefined };
  const ref = path.slice(at + 1);
  if (ref === "") return invalidGitVcsSource();
  return { repoPath: path.slice(0, at), fetchPath: path.slice(0, at), ref };
}

function parseGitRepositoryPath(path: string): string {
  const segments = path.slice(1).split("/");
  if (segments.length < 2 || hasInvalidPathSegment(path.slice(1))) return invalidGitVcsSource();
  const last = (segments.at(-1) ?? "").replace(/\.git$/i, "");
  if (last === "") return invalidGitVcsSource();
  segments[segments.length - 1] = last;
  return segments.join("/").toLowerCase();
}

function parseSubdirectory(fragment: string | undefined): string | undefined {
  if (fragment === undefined) return undefined;
  const prefix = "subdirectory=";
  if (!fragment.startsWith(prefix)) return invalidGitVcsSource();
  const path = fragment.slice(prefix.length);
  if (path === "" || hasInvalidPathSegment(path)) return invalidGitVcsSource();
  return path;
}

function invalidGitVcsSource(): never {
  throw new SourceParseError("invalid Git VCS source", GIT_VCS_HELP);
}

function parseGitHubBrowserLink(text: string): RemoteSource {
  const { url, segments } = browserPathSegments(text);
  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/, "");
  if (!validGitHubRepository(owner, repository)) {
    throw new Error(`invalid GitHub browser link ${url}`);
  }

  const suffix = segments.slice(2);
  if (suffix.length === 0) return githubSource(owner, repository, {});
  const [kind, ...rest] = suffix;
  if ((kind !== "tree" && kind !== "blob") || rest.length === 0) {
    throw new Error(`unsupported GitHub browser URL path in ${url}`);
  }
  const restPath = rest.join("/");
  if (hasInvalidPathSegment(restPath)) throw new Error(`invalid path segment in ${restPath}`);
  return { ...githubSource(owner, repository, {}), browserLink: { kind, rest: restPath } };
}

function browserPathSegments(text: string): {
  readonly url: string;
  readonly segments: [string, string, ...string[]];
} {
  const url = text.split(/[?#]/, 1)[0] ?? text;
  const pathname = url.replace(/^https:\/\/github\.com/i, "");
  const segments = pathname.startsWith("/") ? pathname.slice(1).split("/") : [];
  if (segments.at(-1) === "") segments.pop();
  if (!isBrowserPathSegments(segments)) throw new Error(`invalid GitHub browser link ${url}`);
  return { url, segments };
}

function isBrowserPathSegments(segments: string[]): segments is [string, string, ...string[]] {
  return segments.length >= 2 && segments.every((segment) => segment !== "");
}

function validGitHubRepository(owner: string, repository: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(owner) &&
    /^[A-Za-z0-9._-]+$/.test(repository) &&
    repository !== "." &&
    repository !== ".."
  );
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
