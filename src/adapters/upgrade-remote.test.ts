import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const REMOTE_SOURCES = [
  "github:acme/loops",
  "upgrade-test-owner/upgrade-test-repo",
  "https://github.com/acme/loops",
  "https://github.com/acme/loops/tree/main/review",
  "https://github.com/acme/loops/blob/main/review.loop",
  "git+https://example.test/acme/loops",
  "git+ssh://git@example.test/acme/loops",
];

test("upgrade refuses every remote source without git on PATH", () => {
  for (const source of REMOTE_SOURCES) {
    const result = spawnSync(process.execPath, [CLI, "upgrade", source], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.error, undefined, source);
    assert.equal(result.status, 2, source);
    assert.equal(result.stdout, "", source);
    assert.equal(
      result.stderr,
      "error: upgrade cannot write to a Remote Loopfile\n" +
        "code: bad_argument\n" +
        "help: Make a local copy first: loopfile unpack <source> [<destination>]\n",
      source,
    );
  }
});
