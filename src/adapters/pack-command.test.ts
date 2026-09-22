import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { list } from "tar";
import { loadDirectory, loadPacked } from "./directory-loader.ts";
import { packCommand } from "./pack-command.ts";

const dir = await mkdtemp(join(tmpdir(), "loopfile-pack-"));
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

async function source(manifest: string | null = MANIFEST): Promise<string> {
  const path = join(dir, `feature${count++}`, "feature");
  await mkdir(join(path, "prompts"), { recursive: true });
  await mkdir(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git", "HEAD"), "ref");
  await writeFile(join(path, "prompts", "build.md"), "Build it");
  await writeFile(join(path, "notes.txt"), "not named by the manifest");
  if (manifest !== null) await writeFile(join(path, "manifest.yaml"), manifest);
  return path;
}

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await packCommand(
    ["pack", ...argv],
    (t) => (out += t),
    (t) => (err += t),
  );
  return { code, out, err };
}

async function entries(file: string): Promise<string[]> {
  const paths: string[] = [];
  await list({ file, onReadEntry: (e) => paths.push(`${e.type}:${e.path}`) });
  return paths.sort();
}

test("packs every file but .git, with manifest.yaml at the root", async () => {
  const src = await source();
  const output = join(dir, "out1.loop");
  const { code, out, err } = await run(src, "-o", output);
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.equal(err, `packed: ${output}\n`);
  assert.deepEqual(await entries(output), [
    "File:manifest.yaml",
    "File:notes.txt",
    "File:prompts/build.md",
  ]);
});

test("the archive loads to the same model as the directory", async () => {
  const src = await source();
  const output = join(dir, "out2.loop");
  await run(src, "-o", output);
  assert.deepEqual(await loadPacked(output), await loadDirectory(src));
});

test("the default output is <name>.loop in the current folder", async () => {
  const src = await source();
  const before = process.cwd();
  const cwd = await mkdtemp(join(dir, "cwd-"));
  process.chdir(cwd);
  try {
    const { code, out, err } = await run(src);
    assert.equal(code, 0);
    assert.deepEqual(await readdir(cwd), ["feature.loop"]);
    assert.equal(out, "");
    assert.match(err, /^packed: .*feature\.loop\n$/);
  } finally {
    process.chdir(before);
  }
});

test("an existing output is an error unless --force", async () => {
  const src = await source();
  const output = join(dir, "out3.loop");
  await writeFile(output, "old");
  const refused = await run(src, "-o", output);
  assert.equal(refused.code, 2);
  assert.equal(refused.out, "");
  assert.match(refused.err, /^error: .*already exists/);
  assert.match(refused.err, /\ncode: bad_argument\n/);
  assert.match(refused.err, /\nhelp: /);
  assert.equal(await readFile(output, "utf8"), "old");
  const forced = await run(src, "-o", output, "--force");
  assert.equal(forced.code, 0);
  assert.equal((await entries(output)).includes("File:manifest.yaml"), true);
});

test("an output inside the directory is not packed into itself", async () => {
  const src = await source();
  const output = join(src, "self.loop");
  await run(src, "-o", output);
  assert.equal((await run(src, "-o", output, "--force")).code, 0);
  assert.equal(
    (await entries(output)).some((e) => e.includes("self.loop")),
    false,
  );
});

test("an invalid manifest gives an error and writes no file", async () => {
  const src = await source("formatVersion: 1\nsteps: []\n");
  const output = join(dir, "bad.loop");
  const { code, out, err } = await run(src, "-o", output);
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.match(err, /not valid/);
  assert.match(err, /\ncode: invalid_manifest\n/);
  assert.match(err, /\nhelp: /);
  assert.deepEqual((await readdir(dir)).includes("bad.loop"), false);
});

test("an invalid manifest reports the line when it has one", async () => {
  const src = await source(MANIFEST.replace("kind: agent", "kind: nope"));
  const { err } = await run(src, "-o", join(dir, "bad2.loop"));
  assert.match(err, /\(line \d+\)/);
});

test("an older format version is refused and writes no file", async () => {
  const src = await source("formatVersion: 0\nsteps: []\n");
  const output = join(dir, "old.loop");
  const { code, err } = await run(src, "-o", output);
  assert.equal(code, 1);
  assert.match(err, /older/);
  assert.equal((await readdir(dir)).includes("old.loop"), false);
});

test("a missing manifest.yaml gives the loader's error", async () => {
  const src = await source(null);
  const { code, err } = await run(src, "-o", join(dir, "none.loop"));
  assert.equal(code, 1);
  assert.match(err, /no manifest\.yaml at the root/);
});

test("a link that points outside the directory is refused", async () => {
  const src = await source();
  await symlink(dir, join(src, "escape"));
  const { code, err } = await run(src, "-o", join(dir, "link.loop"));
  assert.equal(code, 1);
  assert.match(err, /outside the directory/);
});

test("an inside link is packed as a file, never as a link", async () => {
  const src = await source();
  await symlink(join(src, "notes.txt"), join(src, "alias.txt"));
  const output = join(dir, "alias.loop");
  await run(src, "-o", output);
  const found = await entries(output);
  assert.ok(found.includes("File:alias.txt"));
  assert.equal(
    found.some((e) => e.startsWith("SymbolicLink")),
    false,
  );
});

test("a thin .loop file is an error that says pack takes a source directory", async () => {
  const file = join(dir, "thin.loop");
  await writeFile(file, MANIFEST);
  const { code, out, err } = await run(file);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /not a source directory/);
  assert.match(err, /\ncode: bad_argument\n/);
});

test("bad arguments are a usage error", async () => {
  for (const args of [[], ["a", "b"], ["--nope"]]) {
    const { code, err } = await run(...args);
    assert.equal(code, 2);
    assert.match(err, /Usage: loopfile pack/);
  }
});

async function digest(path: string, out: string): Promise<string> {
  assert.equal((await run(path, "-o", out, "--force")).code, 0);
  return createHash("sha256")
    .update(gunzipSync(await readFile(out)))
    .digest("hex");
}

test("packing twice gives the same tar bytes", async () => {
  const path = await source();
  assert.equal(await digest(path, join(dir, "a.loop")), await digest(path, join(dir, "b.loop")));
});

test("copies with other mtimes, creation order and modes give the same bytes", async () => {
  const one = await source();
  const two = join(dir, `copy${count++}`, "feature");
  await mkdir(join(two, "prompts"), { recursive: true });
  await writeFile(join(two, "prompts", "build.md"), "Build it");
  await writeFile(join(two, "notes.txt"), "not named by the manifest");
  await writeFile(join(two, "manifest.yaml"), MANIFEST);
  await chmod(join(two, "notes.txt"), 0o664);
  await utimes(join(two, "notes.txt"), 1000, 1000);
  assert.equal(await digest(one, join(dir, "c.loop")), await digest(two, join(dir, "d.loop")));
});

test("changing one byte of one file changes the bytes", async () => {
  const path = await source();
  const before = await digest(path, join(dir, "e.loop"));
  await writeFile(join(path, "notes.txt"), "not named by the manifesu");
  assert.notEqual(await digest(path, join(dir, "f.loop")), before);
});

test("entries are sorted byte-wise with manifest.yaml first, and hold no folders", async () => {
  const path = await source();
  await writeFile(join(path, "B.txt"), "b");
  await writeFile(join(path, "a.txt"), "a");
  await writeFile(join(path, "prompts", "a-b.md"), "x");
  await mkdir(join(path, "empty"));
  await run(path, "-o", join(dir, "g.loop"));
  const seen: string[] = [];
  await list({ file: join(dir, "g.loop"), onReadEntry: (e) => seen.push(e.path) });
  assert.deepEqual(seen, [
    "manifest.yaml",
    "B.txt",
    "a.txt",
    "notes.txt",
    "prompts/a-b.md",
    "prompts/build.md",
  ]);
});

test("entries have mode 0644 or 0755, time 0 and no owner", async () => {
  const path = await source();
  await chmod(join(path, "notes.txt"), 0o775);
  await chmod(join(path, "prompts", "build.md"), 0o600);
  await run(path, "-o", join(dir, "h.loop"));
  const seen: Record<string, string> = {};
  await list({
    file: join(dir, "h.loop"),
    onReadEntry: (e) => {
      seen[e.path] =
        `${(e.mode ?? 0).toString(8)} ${e.mtime?.getTime()} ${e.uid ?? 0} ${e.gid ?? 0} ${e.uname ?? ""}${e.gname ?? ""}`;
    },
  });
  assert.equal(seen["notes.txt"], "755 0 0 0 ");
  assert.equal(seen["prompts/build.md"], "644 0 0 0 ");
  assert.equal(seen["manifest.yaml"], "644 0 0 0 ");
});

test("the deterministic archive loads with the normal loader", async () => {
  const path = await source();
  await run(path, "-o", join(dir, "i.loop"));
  assert.deepEqual(await loadPacked(join(dir, "i.loop")), await loadDirectory(path));
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
