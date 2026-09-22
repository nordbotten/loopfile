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
}

/** Parses the GitHub source form; every other source remains a local path. */
export function parseSource(text: string): ParsedSource {
  const match = /^github:([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(text);
  if (match === null) return { kind: "local", source: text };
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { kind: "remote", host: "github.com", repo, url: `https://github.com/${repo}` };
}
