import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { classifyInput, InputError } from "./input.ts";

const dir = await mkdtemp(join(tmpdir(), "loopfile-input-"));

async function file(name: string, contents: string | Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

test("a directory is a source directory", async () => {
  const path = join(dir, "source");
  await mkdir(path);
  await writeFile(join(path, "manifest.yaml"), "steps: []\n");
  assert.equal(await classifyInput(path), "directory");
});

test("a YAML file is thin, whatever its name", async () => {
  assert.equal(await classifyInput(await file("x.loop", "steps: []\n")), "thin");
  assert.equal(await classifyInput(await file("x.yaml", "steps: []\n")), "thin");
});

test("a UTF-8 manifest with non-ASCII text is thin", async () => {
  assert.equal(await classifyInput(await file("utf8.loop", "# gjør så\nsteps: []\n")), "thin");
});

test("a gzipped archive is packed, whatever its name", async () => {
  // Detection reads the gzip magic only; the tar block inside is never parsed here.
  const archive = gzipSync(Buffer.alloc(1024));
  assert.equal(await classifyInput(await file("x.loop", archive)), "packed");
  assert.equal(await classifyInput(await file("x.tar.gz", archive)), "packed");
});

test("a missing path errors and names the path", async () => {
  const path = join(dir, "gone.loop");
  await assert.rejects(classifyInput(path), (error: Error) => {
    assert.ok(error instanceof InputError);
    assert.match(error.message, new RegExp(path.replaceAll(".", "\\.")));
    return true;
  });
});

test("an empty file errors", async () => {
  await assert.rejects(classifyInput(await file("empty.loop", "")), /empty/);
});

test("a binary file that is not gzip errors", async () => {
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x42, 0x00, 0x80]);
  await assert.rejects(classifyInput(await file("binary.loop", bytes)), /not text/);
});

test("invalid UTF-8 without a NUL byte errors", async () => {
  await assert.rejects(
    classifyInput(await file("latin1.loop", Buffer.from([0xff, 0xfe]))),
    /not text/,
  );
});

test("a special file errors", async () => {
  await assert.rejects(classifyInput("/dev/null"), /not a file or a directory/);
});

test("a truncated UTF-8 character errors", async () => {
  await assert.rejects(
    classifyInput(await file("cut.loop", Buffer.from([0x41, 0xe2, 0x82]))),
    /not text/,
  );
});

test("an unreadable file gives an InputError, not a raw errno", async () => {
  const path = await file("locked.loop", "steps: []\n");
  await chmod(path, 0o000);
  await assert.rejects(classifyInput(path), (error: Error) => {
    assert.ok(error instanceof InputError);
    assert.match(error.message, /cannot read \(EACCES\)/);
    return true;
  });
  await chmod(path, 0o644);
});

test("cleanup", async () => {
  await rm(dir, { recursive: true, force: true });
});
