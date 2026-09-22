import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

test("a non-JSON check prints prose and applies launch input validation", async () => {
  const directory = await source(VALID);
  const io = capture();
  assert.equal(await checkCommand(["check", directory], io.out, io.err), 2);
  assert.equal(io.output, "");
  assert.match(io.errors, /missing --input for issue/);

  const valid = capture();
  assert.equal(
    await checkCommand(["check", directory, "--input", "issue=42"], valid.out, valid.err),
    0,
  );
  assert.equal(valid.output, "Loopfile is valid.\n");
});
