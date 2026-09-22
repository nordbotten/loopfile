import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const gitIdentity = {
  GIT_AUTHOR_NAME: "Loopfile test",
  GIT_AUTHOR_EMAIL: "loopfile-test@example.invalid",
  GIT_COMMITTER_NAME: "Loopfile test",
  GIT_COMMITTER_EMAIL: "loopfile-test@example.invalid",
};

export interface GitFixture {
  readonly root: string;
  readonly repository: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<void>;
}

/** Makes a local GitHub-shaped repository without needing a network or Git identity. */
export async function makeGitFixture(
  files: Readonly<Record<string, string | Uint8Array>>,
  source = "acme/loops",
): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "loopfile-remote-fixture-"));
  const repository = join(root, ...source.split("/"));
  const env = { ...process.env, ...gitIdentity };
  try {
    await mkdir(repository, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: repository, env });
    for (const [path, content] of Object.entries(files)) {
      const destination = join(repository, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await run("git", ["add", "."], { cwd: repository, env });
    await run("git", ["commit", "-q", "-m", "fixture"], { cwd: repository, env });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    repository,
    env: {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
