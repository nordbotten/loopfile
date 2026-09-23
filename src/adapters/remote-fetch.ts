import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { RemoteSource } from "../application/source.ts";

export interface FetchedRemote {
  readonly path: string;
  readonly sha: string;
  readonly remote: Pick<RemoteSource, "host" | "repo" | "path" | "ref">;
  readonly cleanup: () => Promise<void>;
}

/** A Git command failed before a Remote Loopfile could be returned. */
export class RemoteFetchError extends Error {
  readonly stderr: string;
  readonly code: "bad_argument" | "git_missing" | "fetch_failed" | "operation_failed";

  constructor(
    message: string,
    stderr = message,
    code: "bad_argument" | "git_missing" | "fetch_failed" | "operation_failed" = "operation_failed",
  ) {
    super(message);
    this.name = "RemoteFetchError";
    this.stderr = stderr;
    this.code = code;
  }
}

/** Fetches one Git repository without running anything from it. */
export async function fetchRemote(
  source: RemoteSource,
  env: Record<string, string | undefined> = process.env,
): Promise<FetchedRemote> {
  const gitEnv = {
    ...env,
    GIT_LFS_SKIP_SMUDGE: "1",
    ...(process.stdin.isTTY === true && process.stderr.isTTY === true
      ? {}
      : { GIT_TERMINAL_PROMPT: "0" }),
  };
  const refs = source.browserLink === undefined ? undefined : await advertisedRefs(source, gitEnv);
  const resolvedSource = refs === undefined ? source : splitBrowserLink(source, refs);
  const sha = await resolveRef(resolvedSource, gitEnv, refs);
  // The caller's TMPDIR, so a test (or a sandbox) can keep the fetch out of the shared temp folder.
  const temporary = await mkdtemp(join(env.TMPDIR || tmpdir(), "loopfile-remote-"));
  const repository = join(temporary, "repo");
  try {
    const fetched = await checkoutRemote(resolvedSource, sha, gitEnv, repository);
    const { host, repo, path, ref } = resolvedSource;
    return {
      ...fetched,
      remote: {
        host,
        repo,
        ...(path === undefined ? {} : { path }),
        ...(ref === undefined ? {} : { ref }),
      },
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function checkoutRemote(
  source: RemoteSource,
  sha: string | undefined,
  env: Record<string, string | undefined>,
  repository: string,
): Promise<{ readonly path: string; readonly sha: string }> {
  let checkoutSha: string;
  if (sha === undefined) {
    checkoutSha = await fallbackCheckout(source, undefined, env, repository);
  } else {
    await initializeRepository(source, repository, env);
    try {
      await git(
        ["fetch", "-q", "--depth", "1", "--filter=blob:none", "--no-tags", source.url, sha],
        repository,
        env,
      );
      await git(
        ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"],
        repository,
        env,
      );
      checkoutSha = sha;
    } catch {
      checkoutSha = await fallbackCheckout(source, sha, env, repository);
    }
  }
  const path = source.path === undefined ? repository : join(repository, source.path);
  if (source.path !== undefined) await assertSourcePath(source, path, checkoutSha);
  return { path, sha: checkoutSha };
}

async function initializeRepository(
  source: RemoteSource,
  repository: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  await rm(repository, { recursive: true, force: true });
  await mkdir(repository);
  await git(["init", "-q"], repository, env);
  if (source.path !== undefined) {
    await git(["sparse-checkout", "set", "--no-cone", `/${source.path}`], repository, env);
  }
}

async function fallbackCheckout(
  source: RemoteSource,
  shaFromFirstTry: string | undefined,
  env: Record<string, string | undefined>,
  repository: string,
): Promise<string> {
  await initializeRepository(source, repository, env);
  await git(
    [
      "fetch",
      "-q",
      "--no-tags",
      source.url,
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    ],
    repository,
    env,
  );
  const sha = shaFromFirstTry ?? (await resolveFetchedRef(source, repository, env));
  await git(["-c", "advice.detachedHead=false", "checkout", "-q", sha], repository, env);
  return sha;
}

async function resolveFetchedRef(
  source: RemoteSource,
  repository: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const ref = source.ref;
  if (ref === undefined) throw new Error("fallback ref is missing");
  const result = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    repository,
    env,
  ).catch(() => undefined);
  const sha = result?.stdout.trim();
  if (sha !== undefined && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
  throw new RemoteFetchError(
    `ref ${ref} not found in ${source.host}/${source.repo}`,
    undefined,
    "bad_argument",
  );
}

async function assertSourcePath(source: RemoteSource, path: string, sha: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    throw new RemoteFetchError(
      `path ${source.path} not found in ${source.host}/${source.repo} at ${sha.slice(0, 7)}`,
      undefined,
      "bad_argument",
    );
  }
}

async function advertisedRefs(
  source: RemoteSource,
  env: Record<string, string | undefined>,
): Promise<Map<string, string>> {
  const result = await git(["ls-remote", source.url], undefined, env);
  return parseAdvertisedRefs(result.stdout);
}

function splitBrowserLink(source: RemoteSource, refs: Map<string, string>): RemoteSource {
  const link = source.browserLink;
  if (link === undefined) return source;
  const split = splitBrowserRest(link.rest, refs);
  if (split === undefined) {
    throw new RemoteFetchError(
      `no branch, tag or commit in ${link.rest}`,
      undefined,
      "bad_argument",
    );
  }
  if (link.kind === "blob" && !split.path.endsWith(".loop")) {
    throw new RemoteFetchError("a /blob/ link must name a .loop file", undefined, "bad_argument");
  }
  const { browserLink: _browserLink, ...remote } = source;
  return { ...remote, ref: split.ref, ...(split.path === "" ? {} : { path: split.path }) };
}

function splitBrowserRest(
  rest: string,
  refs: Map<string, string>,
): { readonly ref: string; readonly path: string } | undefined {
  const ref = advertisedRefNames(refs).find((name) => rest === name || rest.startsWith(`${name}/`));
  if (ref !== undefined) {
    return { ref, path: rest === ref ? "" : rest.slice(ref.length + 1) };
  }
  const [first, ...path] = rest.split("/");
  return /^[0-9a-f]{7,40}$/i.test(first ?? "")
    ? { ref: first ?? "", path: path.join("/") }
    : undefined;
}

function advertisedRefNames(refs: Map<string, string>): string[] {
  return [...refs.keys()]
    .filter((name) => name.startsWith("refs/heads/") || name.startsWith("refs/tags/"))
    .filter((name) => !name.endsWith("^{}"))
    .map((name) => name.replace(/^refs\/(?:heads|tags)\//, ""))
    .sort((a, b) => b.length - a.length);
}

function parseAdvertisedRefs(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (sha !== undefined && ref !== undefined && /^[0-9a-f]{40}$/i.test(sha)) {
      refs.set(ref, sha.toLowerCase());
    }
  }
  return refs;
}

async function resolveRef(
  source: RemoteSource,
  env: Record<string, string | undefined>,
  knownRefs?: Map<string, string>,
): Promise<string | undefined> {
  const refs = knownRefs ?? (await advertisedRefs(source, env));
  return source.ref === undefined
    ? resolveDefaultRef(source, refs)
    : resolveExplicitRef(source, refs, source.ref);
}

function resolveDefaultRef(source: RemoteSource, refs: Map<string, string>): string {
  const sha = refs.get("HEAD");
  if (sha !== undefined) return sha;
  throw new RemoteFetchError(
    `git ls-remote returned no full HEAD SHA for ${source.host}/${source.repo}`,
  );
}

function resolveExplicitRef(
  source: RemoteSource,
  refs: Map<string, string>,
  ref: string,
): string | undefined {
  const advertisedSha =
    refs.get(`refs/tags/${ref}^{}`) ??
    refs.get(`refs/tags/${ref}`) ??
    refs.get(`refs/heads/${ref}`);
  if (advertisedSha !== undefined) return advertisedSha;
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  if (/^[0-9a-f]{7,39}$/i.test(ref)) return undefined;
  throw new RemoteFetchError(
    `ref ${ref} not found in ${source.host}/${source.repo}`,
    undefined,
    "bad_argument",
  );
}

interface GitResult {
  readonly stdout: string;
}

async function git(
  args: readonly string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
): Promise<GitResult> {
  const child = spawn("git", [...args], {
    cwd,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const [stdout, stderr, code] = await Promise.all([
    readOutput(child.stdout),
    readOutput(child.stderr),
    waitForExit(child),
  ]);
  if (code !== 0) {
    const output = redactCredentials(stderr.trim());
    const message = output || `git exited with code ${code ?? "unknown"}`;
    const failureCode =
      code === 128 && (args[0] === "ls-remote" || args[0] === "fetch")
        ? "fetch_failed"
        : "operation_failed";
    throw new RemoteFetchError(message, output, failureCode);
  }
  return { stdout };
}

function redactCredentials(text: string): string {
  return text.replace(/((?:https?|ssh):\/\/)[^/\s@]+@/gi, "$1");
}

async function readOutput(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new RemoteFetchError("git is not on PATH", undefined, "git_missing")
          : new RemoteFetchError(error.message),
      ),
    );
    child.once("close", resolve);
  });
}
