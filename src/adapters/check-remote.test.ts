import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../cli.ts";
import { makeGitFixture } from "./remote-fixture.ts";

const MANIFEST = "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: 'true'\n";
const USAGE =
  "Usage: loopfile check <directory|file.loop|github:owner/repo[/path][@ref]|git+https://…|git+ssh://…|-> [--json] [--input <name>=<value>]...";

function run(argv: string[], env: Record<string, string | undefined>) {
  let output = "";
  let errors = "";
  const code = main(
    argv,
    (text) => {
      output += typeof text === "string" ? text : Buffer.from(text).toString();
    },
    (text) => {
      errors += text;
    },
    env,
  );
  return {
    code,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
  };
}

async function makeRemote(manifest = MANIFEST) {
  const fixture = await makeGitFixture({ "review/manifest.yaml": manifest });
  const temp = join(fixture.root, "temp");
  await mkdir(temp);
  return {
    fixture,
    temp,
    env: { ...fixture.env, TMPDIR: temp, LOOPFILE_HOME: join(fixture.root, "no-home") },
    sha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.repository,
      encoding: "utf8",
    }).trim(),
  };
}

test("check fetches a remote Loopfile without trust or a terminal and prints its full SHA", async (t) => {
  const { fixture, temp, env, sha } = await makeRemote();
  t.after(() => fixture.cleanup());

  const result = run(["check", "github:acme/loops/review@main"], env);
  assert.equal(await result.code, 0, result.errors);
  assert.equal(
    result.output,
    `remote: github.com/acme/loops/review @ main (${sha})\nLoopfile is valid.\n`,
  );
  assert.equal(result.errors, "");
  assert.deepEqual(await readdir(temp), []);
});

test("check prints the remote line before invalid-manifest errors and removes the fetch folder", async (t) => {
  const { fixture, temp, env, sha } = await makeRemote("formatVersion: 1\nsteps: nope\n");
  t.after(() => fixture.cleanup());

  const result = run(["check", "github:acme/loops/review@main"], env);
  assert.equal(await result.code, 1);
  assert.ok(result.output.startsWith(`remote: github.com/acme/loops/review @ main (${sha})\n`));
  assert.match(result.output, /steps/);
  assert.deepEqual(await readdir(temp), []);
});

test("JSON check omits the remote line", async (t) => {
  const { fixture, temp, env } = await makeRemote();
  t.after(() => fixture.cleanup());

  const result = run(["check", "github:acme/loops/review@main", "--json"], env);
  assert.equal(await result.code, 0, result.errors);
  assert.equal(result.output, "[]\n");
  assert.doesNotMatch(result.output, /^remote:/m);
  assert.deepEqual(await readdir(temp), []);
});

test("check refuses --trust with bad_argument and check usage", async () => {
  const result = run(["check", "github:acme/loops/review@main", "--trust"], {
    ...process.env,
    PATH: "",
  });
  assert.equal(await result.code, 2);
  assert.equal(
    result.errors,
    `error: --trust is for launch only\ncode: bad_argument\nhelp: ${USAGE}\n`,
  );
  assert.equal(result.output, "");
});

test("a broken trust.yaml does not stop remote check", async (t) => {
  const { fixture, temp, env, sha } = await makeRemote();
  t.after(() => fixture.cleanup());
  const home = env.LOOPFILE_HOME;
  assert.ok(home);
  await mkdir(home);
  await writeFile(join(home, "trust.yaml"), "not: [valid");

  const result = run(["check", "github:acme/loops/review@main"], env);
  assert.equal(await result.code, 0, result.errors);
  assert.equal(
    result.output,
    `remote: github.com/acme/loops/review @ main (${sha})\nLoopfile is valid.\n`,
  );
  assert.deepEqual(await readdir(temp), []);
});

test("a missing remote path is bad_argument and leaves no fetch folder", async (t) => {
  const { fixture, temp, env } = await makeRemote();
  t.after(() => fixture.cleanup());

  const result = run(["check", "github:acme/loops/missing@main"], env);
  assert.equal(await result.code, 2);
  assert.match(result.errors, /code: bad_argument/);
  assert.deepEqual(await readdir(temp), []);
});

test("a missing git executable reports git_missing", async () => {
  const result = run(["check", "github:acme/loops/review@main"], {
    ...process.env,
    PATH: "",
  });
  assert.equal(await result.code, 2);
  assert.match(result.errors, /code: git_missing/);
});

test("a failed git fetch reports fetch_failed", async (t) => {
  const { fixture, env } = await makeRemote();
  t.after(() => fixture.cleanup());
  const bin = join(fixture.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\nexit 128\n");
  await chmod(join(bin, "git"), 0o755);

  const result = run(["check", "github:acme/loops/review@main"], { ...env, PATH: bin });
  assert.equal(await result.code, 2);
  assert.match(result.errors, /code: fetch_failed/);
});

test("check help names remote sources", async () => {
  const result = run(["check", "--help"], process.env);
  assert.equal(await result.code, 0);
  assert.match(result.output, /github:owner\/repo\[\/path\]\[@ref\]/);
  assert.match(result.output, /never checked against trust\.yaml/);
});
