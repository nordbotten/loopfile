import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteSource } from "../application/source.ts";

export interface FetchedRemote {
  readonly path: string;
  readonly sha: string;
  readonly cleanup: () => Promise<void>;
}

/** A Git command failed before a Remote Loopfile could be returned. */
export class RemoteFetchError extends Error {
  readonly stderr: string;
  readonly code: "bad_argument" | "operation_failed";

  constructor(
    message: string,
    stderr = message,
    code: "bad_argument" | "operation_failed" = "operation_failed",
  ) {
    super(message);
    this.name = "RemoteFetchError";
    this.stderr = stderr;
    this.code = code;
  }
}

/** Fetches one GitHub repository without running anything from it. */
export async function fetchRemote(
  source: RemoteSource,
  env: Record<string, string | undefined> = process.env,
): Promise<FetchedRemote> {
  const gitEnv = { ...env, GIT_LFS_SKIP_SMUDGE: "1" };
  const sha = await resolveRef(source, gitEnv);
  // The caller's TMPDIR, so a test (or a sandbox) can keep the fetch out of the shared temp folder.
  const temporary = await mkdtemp(join(env.TMPDIR || tmpdir(), "loopfile-remote-"));
  const repository = join(temporary, "repo");
  try {
    const path = await checkoutRemote(source, sha, gitEnv, repository);
    return { path, sha, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function checkoutRemote(
  source: RemoteSource,
  sha: string,
  env: Record<string, string | undefined>,
  repository: string,
): Promise<string> {
  await mkdir(repository);
  await git(["init", "-q"], repository, env);
  if (source.path !== undefined) {
    await git(["sparse-checkout", "set", "--no-cone", `/${source.path}`], repository, env);
  }
  await git(
    ["fetch", "-q", "--depth", "1", "--filter=blob:none", "--no-tags", source.url, sha],
    repository,
    env,
  );
  await git(["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], repository, env);
  const path = source.path === undefined ? repository : join(repository, source.path);
  if (source.path !== undefined) await assertSourcePath(source, path, sha);
  return path;
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

async function resolveRef(
  source: RemoteSource,
  env: Record<string, string | undefined>,
): Promise<string> {
  const result = await git(["ls-remote", source.url], undefined, env);
  const refs = new Map<string, string>();
  for (const line of result.stdout.trim().split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    if (sha !== undefined && ref !== undefined && /^[0-9a-f]{40}$/i.test(sha)) {
      refs.set(ref, sha.toLowerCase());
    }
  }
  if (source.ref === undefined) {
    const sha = refs.get("HEAD");
    if (sha !== undefined) return sha;
    throw new RemoteFetchError(`git ls-remote returned no full HEAD SHA for ${source.url}`);
  }

  const tag = `refs/tags/${source.ref}`;
  const tagSha = refs.get(tag);
  if (tagSha !== undefined) return refs.get(`${tag}^{}`) ?? tagSha;
  const branchSha = refs.get(`refs/heads/${source.ref}`);
  if (branchSha !== undefined) return branchSha;
  if (/^[0-9a-f]{40}$/i.test(source.ref)) return source.ref.toLowerCase();
  throw new RemoteFetchError(
    `ref ${source.ref} not found in ${source.host}/${source.repo}`,
    undefined,
    "bad_argument",
  );
}

interface GitResult {
  readonly stdout: string;
}

function git(
  args: readonly string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new RemoteFetchError(error.message, stderr.trim() || error.message));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
      } else {
        const message = stderr.trim() || `git exited with code ${code ?? "unknown"}`;
        reject(new RemoteFetchError(message, stderr.trim() || message));
      }
    });
  });
}
