import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fetchRemote, RemoteFetchError } from "./remote-fetch.ts";
import { makeGitFixture } from "./remote-fixture.ts";

const run = promisify(execFile);

test("fetchRemote reports when Git is missing", async () => {
  await assert.rejects(
    fetchRemote(
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
      },
      { ...process.env, PATH: "" },
    ),
    (error: unknown) => error instanceof RemoteFetchError && error.code === "git_missing",
  );
});

test("fetchRemote disables terminal prompts when launched without a terminal", async () => {
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  const bin = join(fixture.root, "bin");
  const promptLog = join(fixture.root, "prompt-env");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
printf '%s' "$GIT_TERMINAL_PROMPT" > "$PROMPT_LOG"
exit 128
`,
  );
  await chmod(join(bin, "git"), 0o755);
  try {
    const script = `import { fetchRemote } from ${JSON.stringify(new URL("./remote-fetch.ts", import.meta.url).href)}; try { await fetchRemote({ kind: "remote", host: "github.com", repo: "acme/loops", url: "https://github.com/acme/loops" }); } catch {}`;
    await run(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...fixture.env,
        PATH: `${bin}${delimiter}${fixture.env.PATH}`,
        PROMPT_LOG: promptLog,
      },
    });
    assert.equal(await readFile(promptLog, "utf8"), "0");
  } finally {
    await fixture.cleanup();
  }
});

test("fetchRemote rejects a repository without an advertised HEAD", async () => {
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  try {
    await run("git", ["symbolic-ref", "HEAD", "refs/heads/missing"], {
      cwd: fixture.repository,
    });
    await assert.rejects(
      fetchRemote(
        {
          kind: "remote",
          host: "github.com",
          repo: "acme/loops",
          url: "https://github.com/acme/loops",
        },
        fixture.env,
      ),
      /git ls-remote returned no full HEAD SHA/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("fetchRemote falls back to the resolved SHA when a branch fetch is refused", async () => {
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  let fetched: Awaited<ReturnType<typeof fetchRemote>> | undefined;
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    const bin = join(fixture.root, "bin");
    await mkdir(bin);
    const realGit = (await run("which", ["git"])).stdout.trim();
    const wrapper = join(bin, "git");
    await writeFile(
      wrapper,
      `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nif (process.argv[2] === "fetch" && process.argv.includes("--depth")) process.exit(1);\nconst result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
    );
    await chmod(wrapper, 0o755);
    const env = { ...fixture.env, PATH: `${bin}${delimiter}${fixture.env.PATH}` };
    fetched = await fetchRemote(
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        ref: "main",
      },
      env,
    );
    assert.equal(fetched.sha, sha);
    assert.equal(
      await readFile(`${fetched.path}/manifest.yaml`, "utf8"),
      "formatVersion: 1\nsteps: []\n",
    );
  } finally {
    await fetched?.cleanup();
    await fixture.cleanup();
  }
});

test("fetchRemote checks out the default branch at its full SHA", async () => {
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  let fetched: Awaited<ReturnType<typeof fetchRemote>> | undefined;
  try {
    fetched = await fetchRemote(
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
      },
      fixture.env,
    );
    const head = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    assert.equal(fetched.sha, head);
    assert.equal(
      await readFile(`${fetched.path}/manifest.yaml`, "utf8"),
      "formatVersion: 1\nsteps: []\n",
    );

    await fetched.cleanup();
    await assert.rejects(stat(dirname(fetched.path)));
    fetched = undefined;
  } finally {
    await fetched?.cleanup();
    await fixture.cleanup();
  }
});
