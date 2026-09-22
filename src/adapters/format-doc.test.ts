import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadDirectory, loadPacked, loadThin, MANIFEST_NAME } from "./directory-loader.ts";
import { packCommand } from "./pack-command.ts";

const DOC = new URL("../../docs/loopfile-format.md", import.meta.url);
const README = new URL("../../README.md", import.meta.url);

const dir = await mkdtemp(join(tmpdir(), "loopfile-formatdoc-"));
after(() => rm(dir, { recursive: true, force: true }));

/** The body of every fenced block whose info string is `yaml <kind>`. */
async function examples(kind: string): Promise<string[]> {
  const text = await readFile(DOC, "utf8");
  const pattern = new RegExp(`^\`\`\`yaml ${kind}\\n([\\s\\S]*?)^\`\`\`$`, "gm");
  return [...text.matchAll(pattern)].map((match) => match[1] as string);
}

test("the document has a source example and a thin example", async () => {
  assert.equal((await examples("source")).length, 1);
  assert.equal((await examples("thin")).length, 1);
});

test("every thin example loads with the real loader", async () => {
  for (const [index, text] of (await examples("thin")).entries()) {
    const file = join(dir, `thin${index}.loop`);
    await writeFile(file, text);
    assert.equal((await loadThin(file)).status, "loaded");
  }
});

test("every source example loads, and its packed form loads too", async () => {
  for (const [index, text] of (await examples("source")).entries()) {
    const source = join(dir, `source${index}`);
    await mkdir(join(source, "prompts"), { recursive: true });
    await writeFile(join(source, MANIFEST_NAME), text);
    await writeFile(join(source, "prompts", "build.md"), "Build it\n");
    assert.equal((await loadDirectory(source)).status, "loaded");

    const packed = join(dir, `packed${index}.loop`);
    const code = await packCommand(["pack", source, "-o", packed], noop, noop);
    assert.equal(code, 0);
    assert.equal((await loadPacked(packed)).status, "loaded");
  }
});

test("the README links to the format document", async () => {
  assert.match(await readFile(README, "utf8"), /\(docs\/loopfile-format\.md\)/);
});

function noop(): void {}
