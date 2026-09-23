import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "tar";
import { parseEventLog } from "../application/replay.ts";
import { main } from "../cli.ts";
import { loadDirectory } from "./directory-loader.ts";
import { packCommand } from "./pack-command.ts";
import { makeGitFixture } from "./remote-fixture.ts";
import { runPaths } from "./run-directory.ts";
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
const COMMAND_MANIFEST =
  "formatVersion: 1\nsteps:\n  - id: local\n    kind: command\n    run: 'true'\n";

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

async function runCli(argv: string[], env: Record<string, string | undefined>) {
  let out = "";
  let err = "";
  const code = await main(
    argv,
    (text) => (out += typeof text === "string" ? text : Buffer.from(text).toString()),
    (text) => (err += text),
    env,
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

test("a remote folder unpacks without trust and defaults to its Loopfile name", async (t) => {
  const fixture = await makeGitFixture({
    "review/manifest.yaml": COMMAND_MANIFEST,
    "review/prompts/build.md": "Build it",
  });
  t.after(() => fixture.cleanup());
  const temp = join(fixture.root, "temp");
  const work = join(fixture.root, "work");
  const home = join(dir, `remote-home-${count++}`);
  await Promise.all([mkdir(temp), mkdir(work)]);
  const env = { ...fixture.env, TMPDIR: temp, LOOPFILE_HOME: home };
  const cwd = process.cwd();
  process.chdir(work);
  try {
    const destination = join(work, "review");
    const result = await runCli(["unpack", "github:acme/loops/review@main"], env);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, "");
    assert.match(
      result.err,
      new RegExp(
        `^unpacked: ${destination}\\nremote: github\\.com/acme/loops/review @ main \\([0-9a-f]{40}\\)\\n$`,
      ),
    );
    assert.equal((await loadDirectory(destination)).status, "loaded");
    assert.equal(await readFile(join(destination, "prompts/build.md"), "utf8"), "Build it");
    const launched = await runCli([destination, "-d"], env);
    assert.equal(launched.code, 0, launched.err);
    assert.match(launched.err, /^started: /);
    assert.doesNotMatch(launched.err, /untrusted|trust prompt/i);
    const runId = launched.out.trim();
    const eventsPath = runPaths(home, runId).events;
    for (let tries = 0; tries < 400; tries += 1) {
      const events = parseEventLog(await readFile(eventsPath, "utf8").catch(() => ""));
      if (events.some((event) => event.type === "run.ended")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const events = parseEventLog(await readFile(eventsPath, "utf8"));
    assert.ok(events.some((event) => event.type === "run.ended"));
    assert.deepEqual(await readdir(temp), []);
    await assert.rejects(readFile(join(home, "trust.yaml")), { code: "ENOENT" });
  } finally {
    process.chdir(cwd);
  }
});

test("a remote root folder omits .git and defaults to the repository name", async (t) => {
  const fixture = await makeGitFixture({ "manifest.yaml": COMMAND_MANIFEST, "asset.txt": "asset" });
  t.after(() => fixture.cleanup());
  const temp = join(fixture.root, "temp");
  const work = join(fixture.root, "work");
  await Promise.all([mkdir(temp), mkdir(work)]);
  const env = { ...fixture.env, TMPDIR: temp, LOOPFILE_HOME: join(fixture.root, "no-home") };
  const cwd = process.cwd();
  process.chdir(work);
  try {
    const result = await runCli(["unpack", "github:acme/loops@main"], env);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err.split("\n")[0], `unpacked: ${join(work, "loops")}`);
    assert.equal((await loadDirectory(join(work, "loops"))).status, "loaded");
    assert.equal((await readdir(join(work, "loops"))).includes(".git"), false);
    assert.deepEqual(await readdir(temp), []);
  } finally {
    process.chdir(cwd);
  }
});

test("a remote thin .loop unpacks to a loadable source without trust", async (t) => {
  const fixture = await makeGitFixture({ "review.loop": COMMAND_MANIFEST });
  t.after(() => fixture.cleanup());
  const temp = join(fixture.root, "temp");
  const home = join(fixture.root, "no-home");
  const work = join(fixture.root, "work");
  await Promise.all([mkdir(temp), mkdir(work)]);
  const env = { ...fixture.env, TMPDIR: temp, LOOPFILE_HOME: home };
  const cwd = process.cwd();
  process.chdir(work);
  try {
    const result = await runCli(["unpack", "github:acme/loops/review.loop@main"], env);
    assert.equal(result.code, 0, result.err);
    assert.equal((await loadDirectory(join(work, "review"))).status, "loaded");
    assert.deepEqual(await readdir(temp), []);
    await assert.rejects(readFile(join(home, "trust.yaml")), { code: "ENOENT" });
  } finally {
    process.chdir(cwd);
  }
});

test("a remote packed .loop unpacks to a loadable source without trust", async (t) => {
  const archive = await readFile(await packed());
  const fixture = await makeGitFixture({ "review.loop": archive });
  t.after(() => fixture.cleanup());
  const temp = join(fixture.root, "temp");
  const home = join(fixture.root, "no-home");
  const work = join(fixture.root, "work");
  await Promise.all([mkdir(temp), mkdir(work)]);
  const env = { ...fixture.env, TMPDIR: temp, LOOPFILE_HOME: home };
  const cwd = process.cwd();
  process.chdir(work);
  try {
    const result = await runCli(["unpack", "github:acme/loops/review.loop@main"], env);
    assert.equal(result.code, 0, result.err);
    assert.equal((await loadDirectory(join(work, "review"))).status, "loaded");
    assert.equal(await readFile(join(work, "review", "prompts/build.md"), "utf8"), "Build it");
    assert.deepEqual(await readdir(temp), []);
    await assert.rejects(readFile(join(home, "trust.yaml")), { code: "ENOENT" });
  } finally {
    process.chdir(cwd);
  }
});

test("--trust is refused with the unpack usage", async () => {
  const result = await run("--trust", "github:acme/loops@main");
  assert.equal(result.code, 2);
  assert.equal(
    result.err,
    "error: --trust is for launch only\ncode: bad_argument\nhelp: Usage: loopfile unpack <file.loop|remote> [<destination>]\n",
  );
});

test("remote path errors are bad_argument and the fetch folder is removed", async (t) => {
  const fixture = await makeGitFixture({ "manifest.yaml": COMMAND_MANIFEST });
  t.after(() => fixture.cleanup());
  const temp = join(fixture.root, "temp");
  await mkdir(temp);
  const result = await runCli(
    ["unpack", "github:acme/loops/missing@main", join(fixture.root, "out")],
    { ...fixture.env, TMPDIR: temp, LOOPFILE_HOME: join(fixture.root, "no-home") },
  );
  assert.equal(result.code, 2);
  assert.match(result.err, /code: bad_argument/);
  assert.deepEqual(await readdir(temp), []);
  await assert.rejects(readdir(join(fixture.root, "out")), { code: "ENOENT" });
});

test("remote unpack reports git_missing and fetch_failed", async (t) => {
  const fixture = await makeGitFixture({ "manifest.yaml": COMMAND_MANIFEST });
  t.after(() => fixture.cleanup());
  const args = ["unpack", "github:acme/loops@main"];
  const missing = await runCli(args, { ...fixture.env, PATH: "" });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /code: git_missing/);

  const bin = join(fixture.root, "bin");
  await mkdir(bin);
  const git = join(bin, "git");
  await writeFile(git, "#!/bin/sh\nexit 128\n");
  await chmod(git, 0o755);
  const failed = await runCli(args, { ...fixture.env, PATH: bin });
  assert.equal(failed.code, 2);
  assert.match(failed.err, /code: fetch_failed/);
});

test("unpack help names remote sources", async () => {
  const result = await run("--help");
  assert.equal(result.code, 0);
  assert.match(result.out, /Usage: loopfile unpack <file\.loop\|remote>/);
  assert.match(result.out, /no trust/);
});

test.after(async () => {
  await rm(dir, { recursive: true, force: true });
});
