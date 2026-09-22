import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { create } from "tar";
import {
  DirectoryLoadError,
  loadDirectory,
  loadPacked,
  loadThin,
  MANIFEST_NAME,
  MAX_EXTRACTED_BYTES,
  materializeDirectory,
  materializePacked,
  materializeThin,
} from "./directory-loader.ts";

const dir = await mkdtemp(join(tmpdir(), "loopfile-dirload-"));
// The big-archive test leaves over 100 MB here, and mutation testing runs this file many times.
after(() => rm(dir, { recursive: true, force: true }));
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
  const path = join(dir, `src${count++}`);
  await mkdir(join(path, "prompts"), { recursive: true });
  await writeFile(join(path, "prompts", "build.md"), "Build it");
  if (manifest !== null) await writeFile(join(path, MANIFEST_NAME), manifest);
  return path;
}

test("a valid directory loads into a model", async () => {
  const result = await loadDirectory(await source());
  assert.equal(result.status, "loaded");
  assert.equal(result.status === "loaded" && result.workflow.steps[0]?.id, "build");
});

test("a missing manifest is an error that names the directory", async () => {
  const path = await source(null);
  await assert.rejects(loadDirectory(path), (error: Error) => {
    assert.ok(error instanceof DirectoryLoadError);
    assert.ok(error.message.includes(path));
    assert.ok(error.message.includes(MANIFEST_NAME));
    return true;
  });
});

test("a missing directory is an error that names it", async () => {
  const path = join(dir, "nope");
  await assert.rejects(loadDirectory(path), /no manifest\.yaml at the root of .*nope/);
});

test("a manifest that is a directory counts as missing", async () => {
  const path = await source(null);
  await mkdir(join(path, MANIFEST_NAME));
  await assert.rejects(loadDirectory(path), /no manifest\.yaml at the root/);
});

test("YAML that does not parse is an error", async () => {
  await assert.rejects(loadDirectory(await source("steps: [")), /is not valid YAML/);
});

test("validation errors carry their line", async () => {
  const result = await loadDirectory(await source(MANIFEST.replace("kind: agent", "kind: nope")));
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.status === "invalid" && result.errors.map((e) => [e.path, e.line]), [
    ["steps[0].kind", 4],
  ]);
});

test("a promptFile that is not in the directory is a validation error", async () => {
  const result = await loadDirectory(await source(MANIFEST.replace("build.md", "gone.md")));
  assert.equal(result.status, "invalid");
});

test("the copy holds every file and the model loads from it", async () => {
  const from = await source();
  await mkdir(join(from, "deep", "er"), { recursive: true });
  await writeFile(join(from, "deep", "er", "x.txt"), "x");
  const to = join(dir, "copy-a");
  await materializeDirectory(from, to);
  assert.equal(await readFile(join(to, "deep", "er", "x.txt"), "utf8"), "x");
  assert.equal(await readFile(join(to, MANIFEST_NAME), "utf8"), MANIFEST);
  assert.equal((await loadDirectory(to)).status, "loaded");
});

test("editing the source after the copy does not change the copy", async () => {
  const from = await source();
  const to = join(dir, "copy-b");
  await materializeDirectory(from, to);
  await writeFile(join(from, "prompts", "build.md"), "Changed");
  assert.equal(await readFile(join(to, "prompts", "build.md"), "utf8"), "Build it");
});

test("materializing onto an existing folder fails", async () => {
  const from = await source();
  const to = await source();
  await assert.rejects(materializeDirectory(from, to), DirectoryLoadError);
});

test("a link inside the directory is followed and copied", async () => {
  const from = await source();
  await symlink("build.md", join(from, "prompts", "alias.md"));
  await symlink("prompts", join(from, "linked"));
  const to = join(dir, "copy-c");
  await materializeDirectory(from, to);
  assert.equal(await readFile(join(to, "prompts", "alias.md"), "utf8"), "Build it");
  assert.equal(await readFile(join(to, "linked", "build.md"), "utf8"), "Build it");
});

test("a link to a file outside the directory is a load error", async () => {
  const from = await source();
  const outside = join(dir, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(from, "prompts", "leak.md"));
  await assert.rejects(loadDirectory(from), /points outside the directory: .*leak\.md/);
  await assert.rejects(materializeDirectory(from, join(dir, "copy-d")), /points outside/);
});

test("a link to a directory outside is a load error", async () => {
  const from = await source();
  await symlink(dir, join(from, "up"));
  await assert.rejects(loadDirectory(from), /points outside/);
});

test("a link inside a linked directory that leaves is a load error", async () => {
  const from = await source();
  await symlink(dir, join(from, "prompts", "up"));
  await assert.rejects(loadDirectory(from), /points outside/);
});

test("a broken link is a load error", async () => {
  const from = await source();
  await symlink("missing", join(from, "prompts", "broken.md"));
  await assert.rejects(loadDirectory(from), /points outside/);
});

const THIN = `formatVersion: 1
steps:
  - id: build
    kind: agent
    harness: claude
    prompt: Build it
    on:
      done: $success
`;

async function thinFile(text: string): Promise<string> {
  const path = join(dir, `thin${count++}.loop`);
  await writeFile(path, text);
  return path;
}

test("a thin .loop and a directory with the same manifest build the same bytes", async () => {
  const thin = await loadThin(await thinFile(THIN));
  const directory = await loadDirectory(await source(THIN));
  assert.equal(thin.status, "loaded");
  assert.equal(directory.status, "loaded");
  assert.equal(
    JSON.stringify(thin.status === "loaded" && thin.workflow),
    JSON.stringify(directory.status === "loaded" && directory.workflow),
  );
});

test("a validation error in a thin .loop carries its line", async () => {
  const result = await loadThin(await thinFile(THIN.replace("kind: agent", "kind: nope")));
  const error = result.status === "invalid" ? result.errors[0] : undefined;
  assert.equal(error?.path, "steps[0].kind");
  assert.equal(error?.line, 4);
});

test("promptFile in a thin .loop is an error that points to a directory or packed .loop", async () => {
  const result = await loadThin(await thinFile(MANIFEST));
  assert.equal(result.status, "invalid");
  const error = result.status === "invalid" ? result.errors[0] : undefined;
  assert.equal(error?.path, "steps[0].promptFile");
  assert.equal(error?.line, 6);
  assert.match(error?.message ?? "", /source directory or a packed \.loop/);
});

test("a thin .loop with bad YAML is thrown with its path", async () => {
  const path = await thinFile("steps: [");
  await assert.rejects(loadThin(path), (error: Error) => {
    assert.ok(error instanceof DirectoryLoadError);
    assert.ok(error.message.includes(path));
    return true;
  });
});

test("a missing thin .loop is an error that names it", async () => {
  await assert.rejects(loadThin(join(dir, "gone.loop")), /cannot read .*gone\.loop \(ENOENT\)/);
});

test("materializeThin writes manifest.yaml and the run ignores later edits", async () => {
  const file = await thinFile(THIN);
  const destination = join(dir, `run${count++}`, "loopfile");
  await materializeThin(file, destination);
  await writeFile(file, "changed");
  assert.equal(await readFile(join(destination, MANIFEST_NAME), "utf8"), THIN);
  assert.equal((await loadDirectory(destination)).status, "loaded");
});

test("materializeThin refuses an existing destination", async () => {
  const destination = await source();
  await assert.rejects(materializeThin(await thinFile(THIN), destination), /already exists/);
});

test("materializeThin reports a missing source", async () => {
  const destination = join(dir, `run${count++}`);
  await assert.rejects(
    materializeThin(join(dir, "gone.loop"), destination),
    /cannot copy .*gone\.loop to .* \(ENOENT\)/,
  );
});

// --- packed .loop (#07) ---

type RawEntry = { path: string; type?: string; body?: string; linkpath?: string };

const TYPE_FLAGS: Record<string, string> = {
  file: "0",
  hardlink: "1",
  symlink: "2",
  char: "3",
  fifo: "6",
};

/** Builds a gzipped tar by hand, so a test can hold entries that `tar.create` refuses. */
function rawArchive(entries: RawEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(TYPE_FLAGS[entry.type ?? "file"] as string, 156);
    header.write(entry.linkpath ?? "", 157, 100);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function packedFile(entries: RawEntry[]): Promise<string> {
  const path = join(dir, `packed${count++}.loop`);
  await writeFile(path, rawArchive(entries));
  return path;
}

const GOOD: RawEntry[] = [
  { path: "manifest.yaml", body: MANIFEST },
  { path: "prompts/build.md", body: "Build it" },
];

async function rejectsPacked(entries: RawEntry[], message: RegExp): Promise<void> {
  const file = await packedFile(entries);
  const destination = join(dir, `out${count++}`);
  await assert.rejects(loadPacked(file), message);
  await assert.rejects(materializePacked(file, destination), message);
}

test("a packed .loop builds the same model as its source directory", async () => {
  const path = await source();
  const file = join(dir, `made${count++}.loop`);
  await create({ file, cwd: path, gzip: true, portable: true }, [MANIFEST_NAME, "prompts"]);
  const packed = await loadPacked(file);
  const direct = await loadDirectory(path);
  assert.equal(packed.status, "loaded");
  assert.equal(JSON.stringify(packed), JSON.stringify(direct));
});

test("materializePacked extracts the files and the copy loads", async () => {
  const file = await packedFile(GOOD);
  const destination = join(dir, `copy${count++}`);
  await materializePacked(file, destination);
  assert.equal(await readFile(join(destination, "prompts", "build.md"), "utf8"), "Build it");
  assert.equal((await loadDirectory(destination)).status, "loaded");
});

test("loadPacked checks promptFile against the archive contents and leaves no temp folder", async () => {
  const file = await packedFile([{ path: "manifest.yaml", body: MANIFEST }]);
  // A private TMPDIR: other test processes make and remove loopfile-packed-* folders in the shared one.
  const own = await mkdtemp(join(tmpdir(), "loopfile-own-tmp-"));
  const shared = process.env.TMPDIR;
  process.env.TMPDIR = own;
  try {
    const result = await loadPacked(file);
    assert.equal(result.status, "invalid");
    assert.deepEqual(await readdir(own), []);
  } finally {
    if (shared === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = shared;
    await rm(own, { recursive: true, force: true });
  }
});

test("materializePacked refuses an existing destination", async () => {
  const file = await packedFile(GOOD);
  await assert.rejects(materializePacked(file, dir), /already exists/);
});

test("an absolute path is a load error", async () => {
  await rejectsPacked([...GOOD, { path: "/tmp/evil" }], /not a relative path/);
});

test("a path with .. is a load error", async () => {
  await rejectsPacked([...GOOD, { path: "a/../../evil" }], /leaves the root/);
});

test("a backslash in a path is a load error", async () => {
  await rejectsPacked([...GOOD, { path: "a\\b" }], /not a relative path/);
});

test("a symbolic link is a load error", async () => {
  await rejectsPacked(
    [...GOOD, { path: "link", type: "symlink", linkpath: "../../etc/passwd" }],
    /SymbolicLink entry link is not allowed/,
  );
});

test("a hard link is a load error", async () => {
  await rejectsPacked(
    [...GOOD, { path: "link", type: "hardlink", linkpath: "/etc/passwd" }],
    /Link entry link is not allowed/,
  );
});

test("a device file is a load error", async () => {
  await rejectsPacked([...GOOD, { path: "dev", type: "char" }], /CharacterDevice entry dev/);
});

test("a FIFO is a load error", async () => {
  await rejectsPacked([...GOOD, { path: "pipe", type: "fifo" }], /FIFO entry pipe/);
});

test("an archive with the manifest only in a subfolder has no manifest at its root", async () => {
  await rejectsPacked(
    [{ path: "feature/manifest.yaml", body: MANIFEST }],
    /no manifest\.yaml at the root of .*packed/,
  );
});

test("an archive of more than 100 MB when extracted is a load error", async () => {
  // Random bytes, so that tar's own decompression-ratio guard does not fire first.
  const big = randomBytes(MAX_EXTRACTED_BYTES / 2 + 1).toString("latin1");
  await rejectsPacked(
    [...GOOD, { path: "a", body: big }, { path: "b", body: big }],
    /more than 100 MB/,
  );
});

test("a truncated archive is an error that names the file", async () => {
  const path = join(dir, `cut${count++}.loop`);
  await writeFile(path, rawArchive(GOOD).subarray(0, 40));
  await assert.rejects(loadPacked(path), (error: Error) => {
    assert.ok(error instanceof DirectoryLoadError);
    assert.ok(error.message.includes(path));
    return true;
  });
});

test("a corrupt archive is an error that names the file", async () => {
  const path = join(dir, `bad${count++}.loop`);
  const bytes = rawArchive(GOOD);
  bytes.fill(0x55, 20, 60);
  await writeFile(path, bytes);
  await assert.rejects(loadPacked(path), new RegExp(`cannot read ${path}`));
});

test("a missing archive is an error that names the file", async () => {
  const path = join(dir, "missing.loop");
  await assert.rejects(loadPacked(path), new RegExp(`cannot read ${path}`));
});
