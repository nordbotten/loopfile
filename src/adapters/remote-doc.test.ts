import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEventLog } from "../application/replay.ts";
import { parseSource, SourceParseError } from "../application/source.ts";
import { matchesTrust, parseTrustList } from "../application/trust.ts";
import { checkCommand } from "./check-command.ts";
import { docsCommand } from "./docs-command.ts";
import { type LaunchIo, launchCommand } from "./launch-command.ts";
import { makeGitFixture } from "./remote-fixture.ts";
import { runPaths } from "./run-directory.ts";
import { unpackCommand } from "./unpack-command.ts";

const DOC = new URL("../../docs/remote-loopfiles.md", import.meta.url);
const README = new URL("../../README.md", import.meta.url);
const RUNTIME = new URL("../../docs/runtime.md", import.meta.url);
const SKILL = new URL("../../skills/loopfile/SKILL.md", import.meta.url);
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const MANIFEST = "formatVersion: 1\nsteps:\n  - id: work\n    kind: command\n    run: 'true'\n";

function launchIo(): {
  readonly io: LaunchIo;
  readonly out: () => string;
  readonly err: () => string;
} {
  let out = "";
  let err = "";
  const input = Object.assign(new PassThrough(), { isTTY: false, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: false });
  return {
    io: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      upgrade: { out: () => {}, err: () => {}, isTTY: false, ask: async () => null },
      trust: { isTTY: false, err: () => {}, choose: async () => null },
      monitor: { input, output },
    },
    out: () => out,
    err: () => err,
  };
}

function shellExamples(text: string): string[] {
  return [...text.matchAll(/^```sh remote\n([\s\S]*?)^```$/gm)].flatMap((match) =>
    (match[1] ?? "").split("\n").filter((line) => line.trim() !== ""),
  );
}

test("every command example runs against a local Git fixture", async (t) => {
  const fixture = await makeGitFixture({
    "manifest.yaml": MANIFEST,
    "review/manifest.yaml": MANIFEST,
    "review.loop": MANIFEST,
  });
  t.after(() => fixture.cleanup());
  const temp = join(fixture.root, "temp");
  const home = join(fixture.root, "home");
  await mkdir(temp);
  const env = {
    ...fixture.env,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_1: `url.file://${fixture.root}/.insteadOf`,
    GIT_CONFIG_VALUE_1: "https://git.example.test/",
    GIT_CONFIG_KEY_2: `url.file://${fixture.root}/.insteadOf`,
    GIT_CONFIG_VALUE_2: "ssh://git.example.test/",
    LOOPFILE_HOME: home,
    TMPDIR: temp,
  };
  const previous = process.cwd();
  process.chdir(fixture.root);
  try {
    for (const command of shellExamples(await readFile(DOC, "utf8"))) {
      if (command.startsWith("loopfile check ")) {
        let out = "";
        let err = "";
        const code = await checkCommand(
          ["check", ...command.slice("loopfile check ".length).split(" ")],
          (text) => (out += text),
          (text) => (err += text),
          async () => Buffer.alloc(0),
          env,
        );
        assert.equal(code, 0, `${command}\n${err}`);
        assert.match(out, /Loopfile is valid\./, command);
        if (
          command === "loopfile check acme/loops/review" ||
          command === "loopfile check ./acme/loops/review"
        ) {
          assert.doesNotMatch(out, /^remote:/m, command);
        } else {
          assert.match(out, /^remote:/m, command);
        }
      } else if (command.startsWith("loopfile unpack ")) {
        let err = "";
        const code = await unpackCommand(
          ["unpack", ...command.slice("loopfile unpack ".length).split(" ")],
          () => {},
          (text) => (err += text),
          env,
        );
        assert.equal(code, 0, `${command}\n${err}`);
      } else if (command.startsWith("loopfile ")) {
        const session = launchIo();
        const code = await launchCommand(
          command.slice("loopfile ".length).split(" "),
          CLI,
          session.io,
          env,
          { repository: fixture.root },
        );
        assert.equal(code, 0, `${command}\n${session.err()}`);
        const runId = session.out().trim();
        assert.ok(runId);
        const events = parseEventLog(await readFile(runPaths(home, runId).events, "utf8"));
        const created = events[0];
        assert.equal(created?.type, "run.created");
        if (created?.type === "run.created") {
          assert.equal(created.remote?.host, "github.com");
          assert.equal(created.remote?.repo, "acme/loops");
          assert.match(created.remote?.sha ?? "", /^[0-9a-f]{40}$/);
        }
      } else {
        assert.fail(`unknown documented command: ${command}`);
      }
    }
    assert.equal(await readFile(join(fixture.root, "review-copy/manifest.yaml"), "utf8"), MANIFEST);
    await assert.rejects(readFile(join(home, "trust.yaml")), { code: "ENOENT" });
  } finally {
    process.chdir(previous);
  }
});

test("the documented refused source forms are rejected", async () => {
  const text = await readFile(DOC, "utf8");
  assert.match(text, /`git\+http:\/\//);
  assert.match(text, /`git\+file:\/\//);
  assert.match(text, /`user@host:org\/repo`/);
  assert.match(text, /GitLab and Bitbucket/);
  for (const source of [
    "git+http://git.example.test/acme/loops",
    "git+file:///tmp/loops",
    "user@host:org/repo",
    "https://gitlab.com/team/loops",
    "https://bitbucket.org/team/loops",
  ]) {
    assert.throws(() => parseSource(source, false), SourceParseError, source);
  }
});

test("the documented trust.yaml example parses and owner entries match whole segments", async () => {
  const text = await readFile(DOC, "utf8");
  const examples = [...text.matchAll(/^```yaml trust\n([\s\S]*?)^```$/gm)];
  assert.equal(examples.length, 1);
  const trust = parseTrustList(examples[0]?.[1]);
  assert.equal(trust.status, "ok");
  if (trust.status !== "ok") return;
  assert.equal(matchesTrust(trust, "github.com/acme/loops"), true);
  assert.equal(matchesTrust(trust, "git.example.test/team/sub/loops"), true);
  assert.equal(matchesTrust(trust, "git.example.test/teamwork/loops"), false);
});

test("README and runtime point to the page, but docs has no remote topic", async () => {
  assert.match(
    await readFile(README, "utf8"),
    /\[Remote Loopfiles\]\(docs\/remote-loopfiles\.md\)/,
  );
  assert.match(await readFile(RUNTIME, "utf8"), /\[Remote Loopfiles\]\(remote-loopfiles\.md\)/);
  assert.match(
    await readFile(SKILL, "utf8"),
    /agent launches a Remote Loopfile, pass `--trust` only if the user asked for that source/,
  );

  let topics = "";
  assert.equal(
    await docsCommand(
      ["docs"],
      (text) => (topics += text),
      () => {},
    ),
    0,
  );
  assert.doesNotMatch(topics, /^remote:/m);
  let error = "";
  assert.equal(
    await docsCommand(
      ["docs", "remote"],
      () => {},
      (text) => (error += text),
    ),
    2,
  );
  assert.match(error, /unknown docs topic 'remote'/);
});
