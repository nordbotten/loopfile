import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "tar";
import { loadDirectory } from "./directory-loader.ts";
import { packCommand } from "./pack-command.ts";
import { unpackCommand } from "./unpack-command.ts";

const dir = await mkdtemp(join(tmpdir(), "loopfile-unpack-"));
let count = 0;

const MANIFEST = `formatVersion: 1
steps:
  - id: build
    kind: agent
    harness: claude
    promptFile: prompts/build.md
    on:
      done: $success
`;

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await unpackCommand(
    ["unpack", ...argv],
    (t) => (out += t),
    (t) => (err += t),
  );
  return { code, out, err };
}

async function packed(): Promise<string> {
  const source = join(dir, `s${count++}`, "feature");
  await mkdir(join(source, "prompts"), { recursive: true });
  await writeFile(join(source, "manifest.yaml"), MANIFEST);
  await writeFile(join(source, "prompts", "build.md"), "Build it");
  await writeFile(join(source, "notes.txt"), "notes");
  const file = join(dir, `p${count++}.loop`);
  assert.equal(
    await packCommand(
      ["pack", source, "-o", file],
      () => {},
      () => {},
    ),
    0,
  );
  return file;
}

test("pack then unpack restores the files, and the result loads", async () => {
  const to = join(dir, `to${count++}`);
  const result = await run(await packed(), to);
  assert.equal(result.code, 0);
  assert.equal(result.out, "");
  assert.equal(result.err, `unpacked: ${to}\n`);
  assert.equal(await readFile(join(to, "manifest.yaml"), "utf8"), MANIFEST);
  assert.equal(await readFile(join(to, "prompts", "build.md"), "utf8"), "Build it");
  assert.equal(await readFile(join(to, "notes.txt"), "utf8"), "notes");
  assert.equal((await loadDirectory(to)).status, "loaded");
});

test("the default destination drops .loop and sits in the current folder", async () => {
  const file = await packed();
  const cwd = process.cwd();
  const work = await mkdtemp(join(dir, "cwd-"));
  process.chdir(work);
  try {
    const result = await run(file);
    assert.equal(result.code, 0);
    const name = file
      .split("/")
      .pop()
      ?.replace(/\.loop$/, "") as string;
    assert.deepEqual(await readdir(work), [name]);
  } finally {
    process.chdir(cwd);
  }
});

test("an empty existing directory is accepted", async () => {
  const to = join(dir, `empty${count++}`);
  await mkdir(to);
  assert.equal((await run(await packed(), to)).code, 0);
  assert.equal(await readFile(join(to, "notes.txt"), "utf8"), "notes");
});

test("a non-empty directory or a file is refused and left alone", async () => {
  const full = join(dir, `full${count++}`);
  await mkdir(full);
  await writeFile(join(full, "keep"), "x");
  const file = join(dir, `file${count++}`);
  await writeFile(file, "x");
  for (const to of [full, file]) {
    const result = await run(await packed(), to);
    assert.equal(result.code, 2);
    assert.match(result.err, /already exists/);
    assert.match(result.err, /\ncode: bad_argument\n/);
  }
  assert.deepEqual(await readdir(full), ["keep"]);
  assert.equal(await readFile(file, "utf8"), "x");
});

test("a thin .loop is copied as manifest.yaml, untouched", async () => {
  const thin = join(dir, `thin${count++}.loop`);
  await writeFile(thin, "formatVersion: 1\nsteps: []\n");
  const to = join(dir, `thinout${count++}`);
  assert.equal((await run(thin, to)).code, 0);
  assert.deepEqual(await readdir(to), ["manifest.yaml"]);
  assert.equal(await readFile(join(to, "manifest.yaml"), "utf8"), "formatVersion: 1\nsteps: []\n");
});

test("an unsafe archive is refused and leaves no destination or temp folder", async () => {
  const src = join(dir, `unsafe${count++}`);
  await mkdir(src);
  await writeFile(join(src, "manifest.yaml"), MANIFEST);
  await symlink("/etc/passwd", join(src, "link"));
  const file = join(dir, `unsafe${count++}.loop`);
  await create({ file, cwd: src, gzip: true }, ["manifest.yaml", "link"]);
  const home = await mkdtemp(join(dir, "home-"));
  const result = await run(file, join(home, "out"));
  assert.equal(result.code, 1);
  assert.match(result.err, /not safe to load/);
  assert.deepEqual(await readdir(home), []);
});

test("a corrupt archive leaves nothing behind", async () => {
  const file = join(dir, `bad${count++}.loop`);
  await writeFile(file, Buffer.from([0x1f, 0x8b, 1, 2, 3, 4, 5, 6, 7, 8]));
  const home = await mkdtemp(join(dir, "home-"));
  const result = await run(file, join(home, "out"));
  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.match(result.err, /cannot unpack/);
  assert.match(result.err, /\ncode: operation_failed\n/);
  assert.match(result.err, /\nhelp: /);
  assert.deepEqual(await readdir(home), []);
});

test("a directory input, a missing file and bad arguments fail", async () => {
  assert.equal((await run(dir)).code, 2);
  assert.equal((await run(join(dir, "nope.loop"))).code, 2);
  const none = await run();
  assert.equal(none.code, 2);
  assert.match(none.err, /Usage: loopfile unpack/);
  assert.equal((await run("a", "b", "c")).code, 2);
  assert.equal((await run("--bogus")).code, 2);
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
