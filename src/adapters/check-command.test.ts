import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkCommand } from "./check-command.ts";
import { writeArchive } from "./pack-command.ts";

const root = await mkdtemp(join(tmpdir(), "loopfile-check-"));
after(() => rm(root, { recursive: true, force: true }));
let count = 0;

const VALID = `formatVersion: 1
inputs:
  issue: The issue number
steps:
  - id: work
    kind: command
    run: test -n "$(echo ok)"
`;

async function source(manifest: string): Promise<string> {
  const directory = join(root, `source-${count++}`);
  await mkdir(directory);
  await writeFile(join(directory, "manifest.yaml"), manifest);
  return directory;
}

function capture() {
  let output = "";
  let errors = "";
  return {
    out: (text: string) => {
      output += text;
    },
    err: (text: string) => {
      errors += text;
    },
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}

test("a valid manifest and its inputs produce an empty JSON result without a run folder", async () => {
  const directory = await source(VALID);
  const io = capture();
  assert.equal(
    await checkCommand(["check", directory, "--json", "--input", "issue=42"], io.out, io.err),
    0,
  );
  assert.equal(io.output, "[]\n");
  assert.equal(io.errors, "");
  await assert.rejects(stat(join(root, "runs")));
});

test("check accepts empty workspace mode without inspecting the target or invoking Git", async () => {
  const directory = await source(`formatVersion: 1
workspace: empty
steps:
  - id: work
    kind: command
    run: echo ok
`);
  const target = join(root, `plain-target-${count++}`);
  const bin = join(root, `bin-${count++}`);
  const gitCalled = join(root, `git-called-${count++}`);
  await mkdir(target);
  await mkdir(bin);
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, `#!/bin/sh\nprintf called > '${gitCalled}'\n`);
  await chmod(fakeGit, 0o755);
  const oldCwd = process.cwd();
  const oldPath = process.env.PATH;
  process.chdir(target);
  process.env.PATH = `${bin}${oldPath === undefined ? "" : `:${oldPath}`}`;
  try {
    const io = capture();
    assert.equal(await checkCommand(["check", directory, "--json"], io.out, io.err), 0);
    assert.deepEqual(JSON.parse(io.output), []);
    assert.equal(io.errors, "");
    assert.deepEqual(await readdir(target), []);
    await assert.rejects(stat(gitCalled), { code: "ENOENT" });
  } finally {
    process.chdir(oldCwd);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("JSON check returns every loader problem with its path and line", async () => {
  const directory = await source(`formatVersion: 1
steps:
  - id: work
    kind: agent
    harness: nope
    extra: true
    prompt: Do it
    on:
      done: $success
`);
  const io = capture();
  assert.equal(await checkCommand(["check", directory, "--json"], io.out, io.err), 1);
  assert.deepEqual(JSON.parse(io.output), [
    {
      path: "steps[0].extra",
      line: 6,
      message: "unknown field `extra`",
    },
    {
      path: "steps[0].harness",
      line: 5,
      message: "harness is required and must be one of: claude, pi",
    },
  ]);
  assert.equal(io.errors, "");
});

test("JSON check rejects an outdated manifest for every source kind", async () => {
  const manifest = "formatVersion: 0\nsteps: []\n";
  const directory = await source(manifest);
  const thin = join(root, `thin-${count++}.loop`);
  await writeFile(thin, manifest);
  const packed = join(root, `packed-${count++}.loop`);
  await writeArchive(directory, packed);

  const inputs = [
    { source: directory },
    { source: thin },
    { source: packed },
    { source: "-", read: async () => Buffer.from(manifest) },
  ];
  for (const input of inputs) {
    const io = capture();
    assert.equal(
      await checkCommand(["check", input.source, "--json"], io.out, io.err, input.read),
      1,
    );
    assert.deepEqual(JSON.parse(io.output), [
      { path: "formatVersion", message: "formatVersion 0 is outdated" },
    ]);
    assert.equal(io.errors, "");
  }
});

test("a manifest from stdin is checked as a thin Loopfile", async () => {
  const io = capture();
  assert.equal(
    await checkCommand(["check", "-", "--json", "--input", "issue=42"], io.out, io.err, async () =>
      Buffer.from(VALID),
    ),
    0,
  );
  assert.equal(io.output, "[]\n");
  assert.equal(io.errors, "");
});

test("check reports stdin, source and manifest read failures", async () => {
  const stdin = capture();
  assert.equal(
    await checkCommand(["check", "-"], stdin.out, stdin.err, async () => {
      throw new Error("closed");
    }),
    1,
  );
  assert.match(stdin.errors, /cannot read stdin: closed/);

  const missing = capture();
  assert.equal(await checkCommand(["check", join(root, "missing")], missing.out, missing.err), 2);
  assert.match(missing.errors, /no such file or directory/);

  const bad = await source("[");
  const failure = capture();
  assert.equal(await checkCommand(["check", bad], failure.out, failure.err), 1);
  assert.match(failure.errors, /not valid YAML/);
});

test("a non-JSON check passes without launch input values", async () => {
  const directory = await source(VALID);
  const io = capture();
  assert.equal(await checkCommand(["check", directory], io.out, io.err), 0);
  assert.equal(io.output, "Loopfile is valid.\n");
  assert.equal(io.errors, "");
});

test("JSON check passes without launch input values", async () => {
  const directory = await source(VALID);
  const io = capture();
  assert.equal(await checkCommand(["check", directory, "--json"], io.out, io.err), 0);
  assert.equal(io.output, "[]\n");
  assert.equal(io.errors, "");
});

test("check help and ADR 0011 distinguish manifest checks from required launch inputs", async () => {
  const help = capture();
  assert.equal(await checkCommand(["check", "--help"], help.out, help.err), 0);
  assert.match(help.output, /manifest and the names of any --input\s+flags given/);
  assert.match(help.output, /Launch still requires each input without\s+a default/);
  assert.doesNotMatch(help.output, /validate .*launch inputs/i);

  const adr = await readFile(
    new URL("../../docs/adr/0011-operator-contract.md", import.meta.url),
    "utf8",
  );
  assert.match(adr, /validates the manifest and the names of any `--input` flags given/);
  assert.match(
    adr,
    /launch will not refuse the manifest itself; launch still checks for missing input values \(#155\)/,
  );
});

test("check accepts some of several required input values", async () => {
  const directory = await source(`formatVersion: 1
inputs:
  issue: The issue number
  title: The issue title
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const io = capture();
  assert.equal(await checkCommand(["check", directory, "--input", "issue=42"], io.out, io.err), 0);
  assert.equal(io.output, "Loopfile is valid.\n");
  assert.equal(io.errors, "");
});

test("check rejects malformed input flags", async () => {
  const directory = await source(VALID);
  const io = capture();
  assert.equal(await checkCommand(["check", directory, "--input", "issue"], io.out, io.err), 2);
  assert.match(io.errors, /error: --input issue needs the form <name>=<value>/);
});

test("check reports every undeclared input on its own error line", async () => {
  const directory = await source(VALID);
  const io = capture();
  assert.equal(
    await checkCommand(
      ["check", directory, "--input", "nope=1", "--input", "another=2"],
      io.out,
      io.err,
    ),
    2,
  );
  assert.equal(
    io.errors,
    "error: --input nope is not declared by the Loopfile. Declared inputs: issue.\n" +
      "error: --input another is not declared by the Loopfile. Declared inputs: issue.\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>.\n",
  );
});

test("check accepts an omitted default and names optional inputs in input failures", async () => {
  const directory = await source(`formatVersion: 1
inputs:
  issue: The issue number
  merge:
    description: Whether to merge
    default: "no"
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const valid = capture();
  assert.equal(
    await checkCommand(["check", directory, "--input", "issue=42"], valid.out, valid.err),
    0,
  );
  assert.equal(valid.output, "Loopfile is valid.\n");

  const invalid = capture();
  assert.equal(
    await checkCommand(["check", directory, "--input", "other=1"], invalid.out, invalid.err),
    2,
  );
  assert.match(invalid.errors, /Optional inputs: merge \(default: no\)/);
});
