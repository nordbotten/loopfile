import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fetchRemote } from "./remote-fetch.ts";
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
    /spawn git ENOENT/,
  );
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
