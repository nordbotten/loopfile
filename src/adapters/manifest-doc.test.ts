import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadDirectory, MANIFEST_NAME } from "./directory-loader.ts";

const DOC = new URL("../../docs/manifest-v1.md", import.meta.url);
const SKILL = new URL("../../skills/loopfile/SKILL.md", import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "loopfile-manifestdoc-"));
after(() => rm(dir, { recursive: true, force: true }));

async function sourceExamples(file: URL): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return [...text.matchAll(/^```yaml source\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] as string,
  );
}

async function loads(text: string, name: string): Promise<void> {
  const source = join(dir, name);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, MANIFEST_NAME), text);
  const result = await loadDirectory(source);
  assert.equal(result.status, "loaded", `${name}: ${JSON.stringify(result)}\n${text}`);
}

test("manifest docs define Profiles, Field expressions, allowed and refused forms, and load checks", async () => {
  const text = await readFile(DOC, "utf8");
  assert.match(text, /\*\*Profile\*\*/);
  assert.match(text, /\*\*Field expression\*\*/);
  assert.match(text, /profiles:/);
  assert.match(text, /implement\.\$\{triage\.complexity/);
  assert.match(text, /\$\{ <expression> \}/);
  for (const operator of [
    "!",
    "&&",
    "||",
    "??",
    "==",
    "!=",
    "===",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "+",
    "*",
    "/",
    "%",
    "?:",
  ]) {
    assert.ok(text.includes(`\`${operator}\``), `missing allowed operator ${operator}`);
  }
  for (const refused of [
    "Function calls",
    "`[...]` access",
    "`this`",
    "`null`",
    "arrays",
    "objects",
    "mixing `??` with `||`",
  ]) {
    assert.ok(text.includes(refused), `missing refused form ${refused}`);
  }
  assert.match(text, /declared input or a declared step output/);
  assert.match(text, /A fixed Profile name must refer to a declared Profile/);
  assert.match(text, /loader checks the full step/);
  assert.match(text, /known fields and field types/);
  assert.match(text, /data-picked Profile/);
  assert.match(text, /`bad_field`/);
});

test("manifest docs distinguish load-time and call-time effort checks", async () => {
  const text = await readFile(DOC, "utf8");
  assert.match(
    text,
    /A fixed word is checked at load; a filled expression is checked before each call/,
  );
});

test("the Loopfile skill shows a Profile-picked lane and a Field expression", async () => {
  const text = await readFile(SKILL, "utf8");
  assert.match(text, /profile: implement\.\$\{triage\.complexity/);
  assert.match(text, /model: claude-\$\{triage\.model/);
  const examples = await sourceExamples(SKILL);
  assert.equal(examples.length, 1);
  await loads(examples[0] ?? "", "skill-example");
});

test("every complete manifest example in the manifest and skill docs loads with the real loader", async () => {
  let count = 0;
  for (const file of [DOC, SKILL]) {
    for (const text of await sourceExamples(file)) {
      await loads(text, `example-${count++}`);
    }
  }
  assert.ok(count >= 3, `expected complete examples, found ${count}`);
});
