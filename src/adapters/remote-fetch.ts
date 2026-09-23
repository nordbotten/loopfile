import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

  constructor(message: string, stderr = message) {
    super(message);
    this.name = "RemoteFetchError";
    this.stderr = stderr;
  }
}

/** Fetches one GitHub repository without running anything from it. */
export async function fetchRemote(
  source: RemoteSource,
  env: Record<string, string | undefined> = process.env,
): Promise<FetchedRemote> {
  const gitEnv = { ...env, GIT_LFS_SKIP_SMUDGE: "1" };
  const sha = await defaultBranchSha(source.url, gitEnv);
  // The caller's TMPDIR, so a test (or a sandbox) can keep the fetch out of the shared temp folder.
  const temporary = await mkdtemp(join(env.TMPDIR || tmpdir(), "loopfile-remote-"));
  const path = join(temporary, "repo");
  try {
    await mkdir(path);
    await git(["init", "-q"], path, gitEnv);
    await git(
      ["fetch", "-q", "--depth", "1", "--filter=blob:none", "--no-tags", source.url, sha],
      path,
      gitEnv,
    );
    await git(["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], path, gitEnv);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    sha,
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}

async function defaultBranchSha(
  url: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const result = await git(["ls-remote", url, "HEAD"], undefined, env);
  const sha = result.stdout.trim().split(/\s+/, 1)[0];
  if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new RemoteFetchError(`git ls-remote returned no full HEAD SHA for ${url}`);
  }
  return sha;
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
