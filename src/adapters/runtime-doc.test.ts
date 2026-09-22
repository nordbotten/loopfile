import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadDirectory, MANIFEST_NAME } from "./directory-loader.ts";

const DOC = new URL("../../docs/runtime.md", import.meta.url);
const README = new URL("../../README.md", import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loopfile-runtimedoc-"));
after(() => rm(dir, { recursive: true, force: true }));

/** The body of every fenced block whose info string is `yaml source`. */
async function examples(): Promise<string[]> {
  const text = await readFile(DOC, "utf8");
  return [...text.matchAll(/^```yaml source\n([\s\S]*?)^```$/gm)].map((m) => m[1] as string);
}

test("the document has an example Loopfile", async () => {
  assert.ok((await examples()).length >= 8);
});

test("every example Loopfile loads with the real loader", async () => {
  for (const [index, text] of (await examples()).entries()) {
    const source = join(dir, `example${index}`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, MANIFEST_NAME), text);
    const loaded = await loadDirectory(source);
    assert.equal(loaded.status, "loaded", `example ${index}:\n${text}\n${JSON.stringify(loaded)}`);
  }
});

test("the documented defaults equal the loader's", async () => {
  const text = await readFile(DOC, "utf8");
  const source = join(dir, "defaults");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, MANIFEST_NAME),
    "formatVersion: 1\nsteps:\n  - id: a\n    kind: ralph\n    harness: claude\n    prompt: go\n    on:\n      x: $success\n",
  );
  const loaded = await loadDirectory(source);
  assert.equal(loaded.status, "loaded");
  const step = (loaded as unknown as { workflow: { steps: Record<string, unknown>[] } }).workflow
    .steps[0];
  assert.equal(step?.maxAttempts, 5);
  assert.equal(step?.maxIterations, 10);
  assert.equal(step?.timeoutMs, 3_600_000);
  assert.match(text, /defaults to `5`/);
  assert.match(text, /defaults to `10`/);
  assert.match(text, /defaults to `1h`/);
});

test("the README links to the runtime document", async () => {
  assert.match(await readFile(README, "utf8"), /\(docs\/runtime\.md\)/);
});
