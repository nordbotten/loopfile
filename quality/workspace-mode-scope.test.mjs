import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("unrelated examples retain their Target repository wording", async () => {
  const [readme, prompt] = await Promise.all([
    readFile(new URL("../examples/implement-review/README.md", import.meta.url), "utf8"),
    readFile(new URL("../examples/implement-review/prompts/implement.md", import.meta.url), "utf8"),
  ]);
  assert.match(readme, /The target repository must\s+have an `npm test` script/);
  assert.match(prompt, /You work on the task in the target repository/);
});
