import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEventLog } from "../application/replay.ts";
import { parseStatusProjection } from "../application/status.ts";
import { parseTrustList } from "../application/trust.ts";
import { type LaunchIo, launchCommand, startRun } from "./launch-command.ts";
import { listCommand } from "./list-command.ts";
import type { MonitorIo } from "./monitor.ts";
import { removeAfterOwnersExit } from "./owner-cleanup.test.ts";
import { writeArchive } from "./pack-command.ts";
import { makeGitFixture } from "./remote-fixture.ts";
import { resultCommand } from "./result-command.ts";
import { runPaths } from "./run-directory.ts";
import { statusCommand } from "./status-command.ts";
import { tailCommand } from "./tail-command.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const root = await realpath(await mkdtemp(join(tmpdir(), "loopfile-launch-")));
after(() => removeAfterOwnersExit(root));
let count = 0;

/** The step reads `input.issue` with the step command, and fails unless it is 42. */
const MANIFEST = `formatVersion: 1
inputs:
  issue: The issue number
steps:
  - id: read
    kind: command
    run: test "$(node ${cli} data get input.issue)" = 42
`;

function markerManifest(marker: string): string {
  return `formatVersion: 1\nsteps:\n  - id: mark\n    kind: command\n    run: 'printf ${marker} > marker.txt'\n`;
}

async function setup(manifest = MANIFEST) {
  count += 1;
  const base = join(root, `case-${count}`);
  const repo = join(base, "repo");
  const source = join(base, "source");
  const home = join(base, "home");
  await mkdir(repo, { recursive: true });
  await mkdir(source);
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo, env: { ...process.env, ...gitEnv } });
  await run("git", ["commit", "-q", "-m", "first"], {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
  });
  await writeFile(join(source, "manifest.yaml"), manifest);
  const env = { ...process.env, ...gitEnv, LOOPFILE_HOME: home };
  return { base, repo, source, home, env };
}

const COPY_MANIFEST = `formatVersion: 1
steps:
  - id: copied
    kind: command
    run: 'test -f .claude/settings.local.json'
`;

async function makeCopyTarget(
  path: string,
  initializeGit: boolean,
  commit: boolean,
): Promise<void> {
  await mkdir(path);
  if (initializeGit) {
    await run("git", ["init", "-q", "-b", "main"], {
      cwd: path,
      env: { ...process.env, ...gitEnv },
    });
  }
  await writeFile(join(path, ".gitignore"), ".claude/settings.local.json\n");
  await writeFile(join(path, "tracked-or-local.txt"), "complete\n");
  if (commit) {
    await run("git", ["add", "."], { cwd: path, env: { ...process.env, ...gitEnv } });
    await run("git", ["commit", "-q", "-m", "first"], {
      cwd: path,
      env: { ...process.env, ...gitEnv },
    });
  }
  await mkdir(join(path, ".claude"));
  await writeFile(join(path, ".claude/settings.local.json"), "ignored\n");
}

async function launchCopy(
  source: string,
  target: string,
  env: NodeJS.ProcessEnv,
  withoutGit = false,
) {
  const s = session();
  let output: string;
  let confirmation: string;
  if (withoutGit) {
    const launched = await run(process.execPath, [cli, source, "-d"], { cwd: target, env });
    output = launched.stdout;
    confirmation = launched.stderr;
  } else {
    assert.equal(
      await launchCommand([source, "-d"], cli, s.io, env, { repository: target }),
      0,
      s.err(),
    );
    output = s.out();
    confirmation = s.err();
  }
  const runId = output.trim();
  const events = await waitForEnd(env.LOOPFILE_HOME as string, runId);
  assert.equal(resultOf(events), "success");
  const created = events[0];
  assert.equal(created?.type, "run.created");
  if (created?.type !== "run.created") throw new Error("run.created is missing");
  const paths = runPaths(env.LOOPFILE_HOME as string, runId);
  assert.deepEqual(
    [created.targetFolder, created.workspacePath, created.isolateKind],
    [target, paths.workspace, "copy"],
  );
  assert.equal(Object.hasOwn(created, "branch"), false);
  assert.equal(Object.hasOwn(created, "baseCommit"), false);
  assert.equal(
    await readFile(join(paths.workspace, ".claude/settings.local.json"), "utf8"),
    "ignored\n",
  );
  assert.equal(await readFile(join(paths.workspace, "tracked-or-local.txt"), "utf8"), "complete\n");
  assert.equal(confirmation, `started: ${runId}\nworkspace: isolate · ${paths.workspace}\n`);
  return { runId, events, paths, session: s };
}

function terminal(tty: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  return { io: { input, output } as MonitorIo, input, text: () => written };
}

function session(
  tty = false,
  choice: number | null = null,
  onChoose?: (
    header: string,
    options: readonly string[],
    defaultIndex: number,
  ) => Promise<number | null>,
  onTrustError?: (text: string) => void,
) {
  let out = "";
  let err = "";
  const choices: { header: string; options: readonly string[]; defaultIndex: number }[] = [];
  const screen = terminal(tty);
  const io: LaunchIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    upgrade: {
      out: () => undefined,
      err: (text) => {
        err += text;
      },
      isTTY: false,
      ask: async () => null,
    },
    trust: {
      isTTY: tty,
      err: (text) => {
        onTrustError?.(text);
        err += text;
      },
      choose: async (header, options, defaultIndex) => {
        choices.push({ header, options, defaultIndex });
        return onChoose === undefined ? choice : await onChoose(header, options, defaultIndex);
      },
    },
    monitor: screen.io,
  };
  return { io, screen, out: () => out, err: () => err, choices };
}

/**
 * A temp folder of the test's own for a remote fetch, so a check that the
 * fetch cleaned up never sees another test's `loopfile-remote-` folder.
 */
async function privateTmp(base: string): Promise<string> {
  const tmp = join(base, "tmp");
  await mkdir(tmp);
  return tmp;
}

async function remoteFolders(tmp: string): Promise<readonly string[]> {
  return (await readdir(tmp)).filter((name) => name.startsWith("loopfile-remote-"));
}

function resultOf(events: ReturnType<typeof parseEventLog>): string | undefined {
  const last = events.at(-1);
  return last?.type === "run.ended" ? last.result : undefined;
}

async function waitForEnd(home: string, runId: string): Promise<ReturnType<typeof parseEventLog>> {
  const paths = runPaths(home, runId);
  for (let tries = 0; tries < 400; tries += 1) {
    const events = parseEventLog(await readFile(paths.events, "utf8").catch(() => ""));
    if (events.some((event) => event.type === "run.ended")) return events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the run did not end");
}

async function blockGit(env: NodeJS.ProcessEnv, folder: string) {
  const bin = join(folder, "no-git");
  const calls = join(folder, "git-calls");
  await mkdir(bin);
  const executable = join(bin, "git");
  await writeFile(executable, `#!/bin/sh\nprintf called >> '${calls}'\nexit 97\n`);
  await chmod(executable, 0o755);
  return { env: { ...env, PATH: `${bin}${delimiter}${process.env.PATH}` }, calls };
}

async function launchRemoteAndWait(
  source: string,
  setupResult: Awaited<ReturnType<typeof setup>>,
  fixtureEnv: NodeJS.ProcessEnv,
  tmp: string,
) {
  const s = session();
  assert.equal(
    await launchCommand(
      [source, "--trust", "-d"],
      cli,
      s.io,
      { ...setupResult.env, ...fixtureEnv, TMPDIR: tmp },
      { repository: setupResult.repo },
    ),
    0,
    s.err(),
  );
  const runId = s.out().trim();
  assert.equal(resultOf(await waitForEnd(setupResult.home, runId)), "success");
  return runPaths(setupResult.home, runId);
}

async function inCwd<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

async function detached(source: string, home: string, env: NodeJS.ProcessEnv, repo: string) {
  const s = session();
  const code = await launchCommand([source, "-d", "--input", "issue=42"], cli, s.io, env, {
    repository: repo,
  });
  assert.equal(code, 0, s.err());
  const runId = s.out().trim();
  assert.match(runId, /^\d{8}-\d{6}-/);
  const events = await waitForEnd(home, runId);
  return { runId, events, paths: runPaths(home, runId) };
}

test("GitHub browser links launch the default branch, folders, slash refs, blobs and SHAs", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({
    "manifest.yaml": markerManifest("root-link"),
    "sub/manifest.yaml": markerManifest("main-folder"),
    "sub/dir/manifest.yaml": markerManifest("nested-folder"),
    "a/x.loop": markerManifest("blob-file"),
    "a/readme.txt": "not a Loopfile\n",
  });
  const tmp = await privateTmp(setupResult.base);
  try {
    const baseSha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    await run("git", ["tag", "v1", baseSha], { cwd: fixture.repository, env: fixture.env });
    await run("git", ["switch", "-q", "-c", "feature/x"], {
      cwd: fixture.repository,
      env: fixture.env,
    });
    await writeFile(join(fixture.repository, "sub/manifest.yaml"), markerManifest("slash-branch"));
    await run("git", ["commit", "-a", "-q", "-m", "slash branch"], {
      cwd: fixture.repository,
      env: fixture.env,
    });
    const branchSha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    await run("git", ["switch", "-q", "main"], { cwd: fixture.repository, env: fixture.env });

    for (const [source, marker] of [
      ["https://github.com/acme/loops", "root-link"],
      ["https://github.com/acme/loops/tree/main/sub/dir", "nested-folder"],
      ["https://github.com/acme/loops/tree/feature/x/sub", "slash-branch"],
      ["https://github.com/acme/loops/blob/v1/a/x.loop", "blob-file"],
      [`https://github.com/acme/loops/tree/${branchSha}/sub`, "slash-branch"],
      [`https://github.com/acme/loops/tree/${branchSha.slice(0, 7)}/sub`, "slash-branch"],
    ] as const) {
      const paths = await launchRemoteAndWait(source, setupResult, fixture.env, tmp);
      assert.equal(await readFile(join(paths.workspace, "marker.txt"), "utf8"), marker, source);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("GitHub browser links refuse unsupported paths, non-.loop blobs and unknown refs", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({
    "manifest.yaml": markerManifest("unused"),
    "a/readme.txt": "not a Loopfile\n",
  });
  try {
    for (const [source, message] of [
      [
        "https://github.com/acme/loops/blob/main/a/readme.txt",
        "a /blob/ link must name a .loop file",
      ],
      ["https://github.com/acme/loops/issues/1", "unsupported GitHub browser URL path"],
      [
        "https://github.com/acme/loops/tree/no-such-ref/sub",
        "no branch, tag or commit in no-such-ref/sub",
      ],
    ] as const) {
      const s = session();
      assert.equal(
        await launchCommand(
          [source, "--trust"],
          cli,
          s.io,
          { ...setupResult.env, ...fixture.env },
          { repository: setupResult.repo },
        ),
        2,
        source,
      );
      assert.ok(s.err().includes(`error: ${message}`), s.err());
      assert.match(s.err(), /code: bad_argument/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("refused Git URL forms exit 2 with their exact bad-argument help", async () => {
  const { repo, env } = await setup();
  for (const [source, help] of [
    [
      "git+http://git.example.test/org/repo",
      "Use git+https:// so the content cannot be changed in transit.",
    ],
    ["git+file:///tmp/repo", "Use the local path."],
    ["user@host:org/repo", "Write it as git+ssh://user@host/org/repo."],
    [
      "https://gitlab.com/org/repo",
      "Use git+https://<host>/<org>/<repo>[@ref][#subdirectory=path].",
    ],
    [
      "https://bitbucket.org/org/repo",
      "Use git+https://<host>/<org>/<repo>[@ref][#subdirectory=path].",
    ],
  ] as const) {
    const s = session();
    assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 2, source);
    assert.match(s.err(), /code: bad_argument/);
    assert.ok(s.err().endsWith(`help: ${help}\n`), s.err());
  }
});

test("a missing Git executable reports git_missing with install help", async () => {
  const { repo, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand(
      ["github:acme/loops", "--trust"],
      cli,
      s.io,
      { ...env, PATH: "" },
      { repository: repo },
    ),
    2,
  );
  assert.equal(
    s.err(),
    "error: git is not on PATH\n" +
      "code: git_missing\n" +
      "help: Install git to run a Remote Loopfile. Local sources do not need it.\n",
  );
});

test("a missing remote repository reports git stderr as fetch_failed", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture(
    { "README.md": "not the requested repository\n" },
    "other/repo",
  );
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/missing", "--trust"],
        cli,
        s.io,
        { ...setupResult.env, ...fixture.env },
        { repository: setupResult.repo },
      ),
      2,
    );
    assert.match(s.err(), /^error: cannot fetch github\.com\/acme\/missing\n/);
    assert.match(s.err(), /\nfatal: .*does not appear to be a git repository\n/);
    assert.match(s.err(), /\ncode: fetch_failed\n/);
    assert.ok(s.err().endsWith("help: Check the name and your access to the repository.\n"));
  } finally {
    await fixture.cleanup();
  }
});

test("a Git fetch exit 128 reports fetch_failed", async () => {
  const { base, repo, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  const bin = join(base, "bin");
  await mkdir(bin);
  const realGit = (await run("which", ["git"])).stdout.trim();
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = fetch ]; then
  echo 'fatal: repository access denied' >&2
  exit 128
fi
exec ${realGit} "$@"
`,
  );
  await chmod(join(bin, "git"), 0o755);
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "--trust"],
        cli,
        s.io,
        { ...env, ...fixture.env, PATH: `${bin}${delimiter}${fixture.env.PATH}` },
        { repository: repo },
      ),
      2,
    );
    assert.match(
      s.err(),
      /^error: cannot fetch github\.com\/acme\/loops\nfatal: repository access denied\n/,
    );
    assert.match(s.err(), /\ncode: fetch_failed\n/);
  } finally {
    await fixture.cleanup();
  }
});

test("Git fetch errors redact credentials from printed URLs", async () => {
  const { repo, env } = await setup();
  const bin = join(repo, "bin");
  await mkdir(bin);
  const wrapper = join(bin, "git");
  await writeFile(
    wrapper,
    "#!/bin/sh\nprintf '%s\\n' \"fatal: unable to access 'https://user:token@git.example.test/org/repo': denied\" >&2\nexit 1\n",
  );
  await chmod(wrapper, 0o755);

  const s = session();
  assert.equal(
    await launchCommand(
      ["git+https://user:token@git.example.test/org/repo", "--trust"],
      cli,
      s.io,
      { ...env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      { repository: repo },
    ),
    2,
  );
  assert.match(s.err(), /code: operation_failed/);
  assert.match(s.err(), /https:\/\/git\.example\.test\/org\/repo/);
  assert.doesNotMatch(`${s.out()}${s.err()}`, /user|token/);
});

test("git+https launches the requested ref and subdirectory from another Git host", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture(
    { "review/manifest.yaml": markerManifest("v1-review") },
    "grp/sub/loops.git",
    "https://user:token@git.example.test/",
  );
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    await run("git", ["tag", "v1", sha], { cwd: fixture.repository, env: fixture.env });
    const s = session();
    assert.equal(
      await launchCommand(
        [
          "git+https://user:token@git.example.test/grp/sub/loops.git@v1#subdirectory=review",
          "--trust",
        ],
        cli,
        s.io,
        { ...setupResult.env, ...fixture.env, TMPDIR: tmp },
        { repository: setupResult.repo },
      ),
      0,
      s.err(),
    );
    const runId = s.out().trim();
    const events = await waitForEnd(setupResult.home, runId);
    assert.equal(resultOf(events), "success");
    const created = events.find((event) => event.type === "run.created");
    assert.deepEqual(created?.type === "run.created" ? created.remote : undefined, {
      host: "git.example.test",
      repo: "grp/sub/loops",
      path: "review",
      ref: "v1",
      sha,
    });
    assert.equal(
      await readFile(join(runPaths(setupResult.home, runId).workspace, "marker.txt"), "utf8"),
      "v1-review",
    );
    assert.deepEqual(await remoteFolders(tmp), []);
  } finally {
    await fixture.cleanup();
  }
});

test("a remote launch records the source and full SHA in run.created and status.json", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "sub/manifest.yaml": markerManifest("recorded") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    const remote = { host: "github.com", repo: "acme/loops", path: "sub", ref: "main", sha };
    for (const source of [
      "github:Acme/Loops/sub@main",
      "https://github.com/Acme/Loops/tree/main/sub",
    ]) {
      const paths = await launchRemoteAndWait(source, setupResult, fixture.env, tmp);
      const created = parseEventLog(await readFile(paths.events, "utf8"))[0];
      const status = parseStatusProjection(JSON.parse(await readFile(paths.status, "utf8")));

      assert.equal(created?.type, "run.created");
      assert.deepEqual(created?.type === "run.created" ? created.remote : undefined, remote);
      assert.deepEqual(status.remote, remote);
      assert.equal(created?.type === "run.created" && created.eventFormatVersion, 1);
      assert.equal(status.formatVersion, 1);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a remote launch on the default branch omits ref from its record", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("default") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    const paths = await launchRemoteAndWait("github:Acme/Loops", setupResult, fixture.env, tmp);
    const created = parseEventLog(await readFile(paths.events, "utf8"))[0];
    const status = parseStatusProjection(JSON.parse(await readFile(paths.status, "utf8")));
    const remote = { host: "github.com", repo: "acme/loops", sha };

    assert.deepEqual(created?.type === "run.created" ? created.remote : undefined, remote);
    assert.deepEqual(status.remote, remote);
    assert.equal(
      created?.type === "run.created" && Object.hasOwn(created.remote ?? {}, "ref"),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a local launch omits remote from run.created and status.json", async () => {
  const setupResult = await setup();
  const launched = await detached(
    setupResult.source,
    setupResult.home,
    setupResult.env,
    setupResult.repo,
  );
  const created = launched.events[0];
  const status = parseStatusProjection(JSON.parse(await readFile(launched.paths.status, "utf8")));

  assert.equal(created?.type, "run.created");
  assert.equal(created?.type === "run.created" && Object.hasOwn(created, "remote"), false);
  assert.equal(Object.hasOwn(status, "remote"), false);
});

test("a trusted GitHub Remote Loopfile runs and uses the repository name", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture({
    "manifest.yaml": "formatVersion: 1\nsteps:\n  - id: done\n    kind: command\n    run: 'true'\n",
  });
  const tmp = await privateTmp(base);
  try {
    const s = session(true);
    assert.equal(
      await launchCommand(
        ["github:Acme/Loops", "--trust", "-d"],
        cli,
        s.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    assert.equal(s.choices.length, 0);
    assert.deepEqual(await remoteFolders(tmp), []);
    const runId = s.out().trim();
    assert.equal(resultOf(await waitForEnd(home, runId)), "success");
    const status = JSON.parse(await readFile(runPaths(home, runId).status, "utf8")) as {
      loopfileName: string;
    };
    assert.equal(status.loopfileName, "loops");
    await assert.rejects(readFile(join(home, "trust.yaml")));
  } finally {
    await fixture.cleanup();
  }
});

test("a bare owner/repo launches its GitHub fixture when no local path exists", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("bare-remote") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const paths = await inCwd(setupResult.base, () =>
      launchRemoteAndWait("acme/loops", setupResult, fixture.env, tmp),
    );
    assert.equal(await readFile(join(paths.workspace, "marker.txt"), "utf8"), "bare-remote");
  } finally {
    await fixture.cleanup();
  }
});

test("an existing bare path and ./ path launch locally without fetching GitHub", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("remote") });
  const local = join(setupResult.base, "acme", "loops");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "manifest.yaml"), markerManifest("local"));
  const tmp = await privateTmp(setupResult.base);
  const bin = join(setupResult.base, "bin");
  await mkdir(bin);
  const gitLog = join(setupResult.base, "git-called");
  const realGit = (await run("which", ["git"])).stdout.trim();
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_CALL_LOG"\nexec ${realGit} "$@"\n`,
  );
  await chmod(join(bin, "git"), 0o755);
  const env = {
    ...setupResult.env,
    ...fixture.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CALL_LOG: gitLog,
    TMPDIR: tmp,
  };
  try {
    await inCwd(setupResult.base, async () => {
      for (const source of ["acme/loops", "./acme/loops"]) {
        const s = session();
        assert.equal(
          await launchCommand([source, "--trust", "-d"], cli, s.io, env, {
            repository: setupResult.repo,
          }),
          0,
          s.err(),
        );
        const runId = s.out().trim();
        assert.equal(resultOf(await waitForEnd(setupResult.home, runId)), "success");
        assert.equal(
          await readFile(join(runPaths(setupResult.home, runId).workspace, "marker.txt"), "utf8"),
          "local",
        );
      }
    });
    assert.doesNotMatch(await readFile(gitLog, "utf8"), /^(?:ls-remote|fetch|clone)\b/m);
  } finally {
    await fixture.cleanup();
  }
});

test("a missing bare repository reports fetch_failed with Git stderr", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture(
    { "README.md": "not the requested repository\n" },
    "other/repo",
  );
  try {
    await inCwd(setupResult.base, async () => {
      const s = session();
      assert.equal(
        await launchCommand(["acme/loops", "--trust", "-d"], cli, s.io, fixture.env, {
          repository: setupResult.repo,
        }),
        2,
      );
      assert.match(s.err(), /^error: cannot fetch github\.com\/acme\/loops\n/);
      assert.match(s.err(), /\nfatal: .*does not appear to be a git repository\n/);
      assert.match(s.err(), /\ncode: fetch_failed\n/);
    });
    await assert.rejects(stat(join(setupResult.home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("remote paths run folders, thin Loopfiles and packed Loopfiles", async () => {
  const setupResult = await setup();
  const packedSource = join(setupResult.base, "packed-source");
  const packedFile = join(setupResult.base, "packed.loop");
  await mkdir(packedSource);
  await writeFile(join(packedSource, "manifest.yaml"), markerManifest("packed"));
  await writeArchive(packedSource, packedFile);
  const fixture = await makeGitFixture({
    "sub/manifest.yaml": markerManifest("folder"),
    "thin.loop": markerManifest("thin"),
    "packed.loop": await readFile(packedFile),
  });
  const tmp = await privateTmp(setupResult.base);
  try {
    for (const [source, marker, loopfileName] of [
      ["github:acme/loops/sub", "folder", "sub"],
      ["github:acme/loops/thin.loop", "thin", "thin.loop"],
      ["github:acme/loops/packed.loop", "packed", "packed.loop"],
    ] as const) {
      const paths = await launchRemoteAndWait(source, setupResult, fixture.env, tmp);
      assert.equal(await readFile(join(paths.workspace, "marker.txt"), "utf8"), marker);
      assert.equal(
        (JSON.parse(await readFile(paths.status, "utf8")) as { loopfileName: string }).loopfileName,
        loopfileName,
      );
      assert.deepEqual(await remoteFolders(tmp), []);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a seven-character SHA checks out a non-tip commit", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("non-tip") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    await writeFile(join(fixture.repository, "manifest.yaml"), markerManifest("tip"));
    await run("git", ["commit", "-a", "-q", "-m", "tip"], {
      cwd: fixture.repository,
      env: fixture.env,
    });

    const paths = await launchRemoteAndWait(
      `github:acme/loops@${sha.slice(0, 7)}`,
      setupResult,
      fixture.env,
      tmp,
    );
    assert.equal(await readFile(join(paths.workspace, "marker.txt"), "utf8"), "non-tip");
  } finally {
    await fixture.cleanup();
  }
});

test("a server refusing an unadvertised SHA falls back to full history", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("non-tip") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    await writeFile(join(fixture.repository, "manifest.yaml"), markerManifest("tip"));
    await run("git", ["commit", "-a", "-q", "-m", "tip"], {
      cwd: fixture.repository,
      env: fixture.env,
    });
    await run("git", ["config", "uploadpack.allowAnySHA1InWant", "false"], {
      cwd: fixture.repository,
    });
    await run("git", ["config", "uploadpack.allowReachableSHA1InWant", "false"], {
      cwd: fixture.repository,
    });
    const env = {
      ...fixture.env,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "protocol.version",
      GIT_CONFIG_VALUE_1: "0",
    };

    const paths = await launchRemoteAndWait(`github:acme/loops@${sha}`, setupResult, env, tmp);
    assert.equal(await readFile(join(paths.workspace, "marker.txt"), "utf8"), "non-tip");
  } finally {
    await fixture.cleanup();
  }
});

test("an unknown short SHA is a bad argument and leaves no remote temp folder", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("unused") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    const missing = sha.startsWith("0000000") ? "1111111" : "0000000";
    const s = session();
    assert.equal(
      await launchCommand(
        [`github:acme/loops@${missing}`, "--trust"],
        cli,
        s.io,
        { ...setupResult.env, ...fixture.env, TMPDIR: tmp },
        { repository: setupResult.repo },
      ),
      2,
    );
    assert.match(s.err(), new RegExp(`error: ref ${missing} not found in github\\.com/acme/loops`));
    assert.match(s.err(), /code: bad_argument/);
    assert.deepEqual(await remoteFolders(tmp), []);
    await assert.rejects(stat(join(setupResult.home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("refs select branch, slash branch, lightweight and annotated tags, full SHA, and tag over branch", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("sha") });
  const tmp = await privateTmp(setupResult.base);
  const env = fixture.env;
  const commit = async (marker: string, message: string) => {
    await writeFile(join(fixture.repository, "manifest.yaml"), markerManifest(marker));
    await run("git", ["add", "manifest.yaml"], { cwd: fixture.repository, env });
    await run("git", ["commit", "-q", "-m", message], { cwd: fixture.repository, env });
    return (await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })).stdout.trim();
  };
  try {
    await run("git", ["switch", "-q", "-c", "feature/with-slash"], {
      cwd: fixture.repository,
      env,
    });
    await commit("slash-branch", "slash branch");
    await run("git", ["switch", "-q", "main"], { cwd: fixture.repository, env });
    await commit("lightweight-tag", "lightweight target");
    await run("git", ["tag", "lightweight"], { cwd: fixture.repository, env });
    await commit("annotated-tag", "annotated target");
    await run("git", ["tag", "-a", "annotated", "-m", "annotated"], {
      cwd: fixture.repository,
      env,
    });
    await run("git", ["branch", "collision"], { cwd: fixture.repository, env });
    await commit("tag-wins", "tag target");
    await run("git", ["tag", "collision"], { cwd: fixture.repository, env });
    const sha = (
      await run("git", ["rev-list", "--max-parents=0", "HEAD"], {
        cwd: fixture.repository,
      })
    ).stdout.trim();

    for (const [ref, marker] of [
      ["", "tag-wins"],
      ["main", "tag-wins"],
      ["feature/with-slash", "slash-branch"],
      ["lightweight", "lightweight-tag"],
      ["annotated", "annotated-tag"],
      [sha, "sha"],
      ["collision", "tag-wins"],
    ] as const) {
      const source = ref === "" ? "github:acme/loops" : `github:acme/loops@${ref}`;
      const paths = await launchRemoteAndWait(source, setupResult, fixture.env, tmp);
      assert.equal(await readFile(join(paths.workspace, "marker.txt"), "utf8"), marker, ref);
      assert.deepEqual(await remoteFolders(tmp), []);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("an unknown ref is a bad argument and leaves no remote temp folder", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("unused") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops@missing", "--trust"],
        cli,
        s.io,
        { ...setupResult.env, ...fixture.env, TMPDIR: tmp },
        { repository: setupResult.repo },
      ),
      2,
    );
    assert.match(s.err(), /error: ref missing not found in github\.com\/acme\/loops/);
    assert.match(s.err(), /code: bad_argument/);
    assert.deepEqual(await remoteFolders(tmp), []);
    await assert.rejects(stat(join(setupResult.home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("a dot segment in a GitHub path is refused as a bad argument", async () => {
  const setupResult = await setup();
  const tmp = await privateTmp(setupResult.base);
  const s = session();
  assert.equal(
    await launchCommand(
      ["github:acme/loops/a/../b", "--trust"],
      cli,
      s.io,
      { ...setupResult.env, TMPDIR: tmp },
      { repository: setupResult.repo },
    ),
    2,
  );
  assert.match(s.err(), /code: bad_argument/);
  assert.deepEqual(await remoteFolders(tmp), []);
});

test("an unknown path is a bad argument and removes its remote temp folder", async () => {
  const setupResult = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("unused") });
  const tmp = await privateTmp(setupResult.base);
  try {
    const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })).stdout
      .trim()
      .slice(0, 7);
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops/missing/path", "--trust"],
        cli,
        s.io,
        { ...setupResult.env, ...fixture.env, TMPDIR: tmp },
        { repository: setupResult.repo },
      ),
      2,
    );
    assert.match(
      s.err(),
      new RegExp(`error: path missing/path not found in github\\.com/acme/loops at ${sha}`),
    );
    assert.match(s.err(), /code: bad_argument/);
    assert.deepEqual(await remoteFolders(tmp), []);
    await assert.rejects(stat(join(setupResult.home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("--trust does not change a local launch", async () => {
  const { repo, source, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand([source, "--trust", "-d", "--input", "issue=42"], cli, s.io, env, {
      repository: repo,
    }),
    0,
    s.err(),
  );
  assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
});

test("a mixed-case repo trust entry launches without --trust", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("trusted-repo") });
  const tmp = await privateTmp(base);
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "trust.yaml"),
    "formatVersion: 1\nrepos:\n  - GITHUB.COM/ACME/LOOPS\n",
  );
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        s.io,
        { ...env, ...fixture.env, TMPDIR: tmp },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  } finally {
    await fixture.cleanup();
  }
});

test("an owner trust entry launches a repository below that owner", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture(
    { "manifest.yaml": markerManifest("trusted-owner") },
    "a/b/x",
    "https://gitlab.com/",
  );
  const tmp = await privateTmp(base);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "trust.yaml"), "formatVersion: 1\nowners:\n  - gitlab.com/a\n");
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["git+https://gitlab.com/a/b/x", "-d"],
        cli,
        s.io,
        { ...env, ...fixture.env, TMPDIR: tmp },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  } finally {
    await fixture.cleanup();
  }
});

test("a broken trust list refuses remote launches without asking, even with --trust", async () => {
  const { repo, home, env } = await setup();
  await mkdir(home, { recursive: true });
  const path = join(home, "trust.yaml");
  for (const contents of [
    "formatVersion: [\n",
    "formatVersion: 2\n",
    "formatVersion: 1\nunknown: true\n",
  ]) {
    await writeFile(path, contents);
    for (const argv of [["github:acme/loops"], ["github:acme/loops", "--trust"]]) {
      const s = session(true);
      assert.equal(await launchCommand(argv, cli, s.io, env, { repository: repo }), 2);
      assert.ok(s.err().startsWith(`error: cannot read trust list ${path}: `), s.err());
      assert.match(s.err(), /\ncode: untrusted\n/);
      assert.ok(s.err().endsWith(`help: Fix or remove ${path}.\n`), s.err());
      assert.equal(s.choices.length, 0);
      assert.equal(await readFile(path, "utf8"), contents);
      assert.equal(s.out(), "");
    }
  }
  await assert.rejects(stat(join(home, "runs")));
});

test("a local launch ignores a broken trust list", async () => {
  const { repo, source, home, env } = await setup();
  await mkdir(home, { recursive: true });
  const path = join(home, "trust.yaml");
  await writeFile(path, "formatVersion: [\n");
  const s = session();
  assert.equal(
    await launchCommand([source, "-d", "--input", "issue=42"], cli, s.io, env, {
      repository: repo,
    }),
    0,
    s.err(),
  );
  assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  assert.equal(await readFile(path, "utf8"), "formatVersion: [\n");
});

test("an untrusted GitHub Remote Loopfile refuses without making a run", async () => {
  const { repo, home, env } = await setup();
  const fixture = await makeGitFixture({
    "manifest.yaml": "formatVersion: 1\nsteps:\n  - id: done\n    kind: command\n    run: 'true'\n",
  });
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops"],
        cli,
        s.io,
        { ...env, ...fixture.env },
        { repository: repo },
      ),
      2,
    );
    assert.match(s.err(), /error: untrusted Remote Loopfile github\.com\/acme\/loops/);
    assert.match(s.err(), /code: untrusted/);
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("Deny writes nothing and refuses an untrusted Remote Loopfile", async () => {
  const { repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("denied") });
  try {
    const s = session(true, 2);
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        s.io,
        { ...env, ...fixture.env },
        {
          repository: repo,
        },
      ),
      2,
    );
    assert.equal(
      s.err(),
      "error: denied trust for github.com/acme/loops\ncode: untrusted\nhelp: Nothing was written. Pass --trust to run it once.\n",
    );
    assert.equal(s.out(), "");
    assert.equal(s.choices.length, 1);
    assert.match(s.choices[0]?.header ?? "", /Source {3}github:acme\/loops/);
    assert.deepEqual(s.choices[0]?.options, [
      "Trust repo github.com/acme/loops",
      "Trust everything from github.com/acme",
      "Deny",
    ]);
    assert.equal(s.choices[0]?.defaultIndex, 2);
    await assert.rejects(readFile(join(home, "trust.yaml")));
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("Ctrl-C or EOF (null pick) writes nothing and refuses with untrusted", async () => {
  const { repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("cancelled") });
  try {
    const s = session(true, null);
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        s.io,
        { ...env, ...fixture.env },
        {
          repository: repo,
        },
      ),
      2,
    );
    assert.match(s.err(), /^error: denied trust for github\.com\/acme\/loops\ncode: untrusted\n/);
    assert.match(s.err(), /help: Nothing was written\. Pass --trust to run it once\.\n$/);
    await assert.rejects(readFile(join(home, "trust.yaml")));
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("Trust repo writes the repository entry and starts the run", async () => {
  const { repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("trusted-repo") });
  try {
    const s = session(true, 0);
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        s.io,
        { ...env, ...fixture.env },
        {
          repository: repo,
        },
      ),
      0,
      s.err(),
    );
    const written = await readFile(join(home, "trust.yaml"), "utf8");
    assert.match(written, /^formatVersion: 1$/m);
    assert.match(written, /^owners: \[\]$/m);
    const trust = parseTrustList(written);
    assert.deepEqual(trust, {
      status: "ok",
      repos: ["github.com/acme/loops"],
      owners: [],
    });
    assert.match(s.err(), /trusted: github\.com\/acme\/loops\ntrust list: .*\/trust\.yaml\n/);
    assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  } finally {
    await fixture.cleanup();
  }
});

test("Trust owner writes the owner entry and starts the run", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture(
    { "manifest.yaml": markerManifest("trusted-owner") },
    "acme/loops",
    "https://gitlab.com/",
  );
  const tmp = await privateTmp(base);
  try {
    const s = session(true, 1);
    assert.equal(
      await launchCommand(
        ["git+https://gitlab.com/acme/loops", "-d"],
        cli,
        s.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    const trust = parseTrustList(await readFile(join(home, "trust.yaml"), "utf8"));
    assert.deepEqual(trust, { status: "ok", repos: [], owners: ["gitlab.com/acme"] });
    assert.match(s.err(), /trusted: gitlab\.com\/acme\ntrust list: .*\/trust\.yaml\n/);
    assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  } finally {
    await fixture.cleanup();
  }
});

test("a second launch from a newly trusted repository asks nothing", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("repeat-trusted") });
  const tmp = await privateTmp(base);
  try {
    const first = session(true, 0);
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        first.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      first.err(),
    );
    assert.equal(resultOf(await waitForEnd(home, first.out().trim())), "success");
    const second = session(true);
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        second.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      second.err(),
    );
    assert.equal(second.choices.length, 0);
    assert.equal(resultOf(await waitForEnd(home, second.out().trim())), "success");
  } finally {
    await fixture.cleanup();
  }
});

test("writing trust preserves comments in the existing trust list", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("keep-comment") });
  const tmp = await privateTmp(base);
  const original =
    "# operator note\nformatVersion: 1\nrepos:\n  - github.com/other/first\n  - github.com/other/second\n# owner note\nowners: []\n";
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "trust.yaml"), original);
  try {
    const s = session(true, 0);
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        s.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    const updated = await readFile(join(home, "trust.yaml"), "utf8");
    assert.ok(updated.indexOf("# operator note") < updated.indexOf("formatVersion: 1"));
    assert.ok(
      updated.indexOf("github.com/other/first") < updated.indexOf("github.com/other/second"),
    );
    assert.ok(
      updated.indexOf("github.com/other/second") < updated.indexOf("github.com/acme/loops"),
    );
    assert.ok(updated.indexOf("# owner note") < updated.indexOf("owners:"));
    assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  } finally {
    await fixture.cleanup();
  }
});

test("a read-only home trust-list write warns and still starts the run", async () => {
  const { base, repo, home, env } = await setup();
  const fixture = await makeGitFixture({ "manifest.yaml": markerManifest("write-failed") });
  const tmp = await privateTmp(base);
  await mkdir(home, { recursive: true });
  if (process.getuid?.() === 0) await mkdir(`${join(home, "trust.yaml")}.${process.pid}.tmp`);
  try {
    const s = session(
      true,
      0,
      async () => {
        await chmod(home, 0o555);
        return 0;
      },
      (text) => {
        if (text.startsWith("warning: cannot write")) chmodSync(home, 0o755);
      },
    );
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "-d"],
        cli,
        s.io,
        {
          ...env,
          ...fixture.env,
          TMPDIR: tmp,
        },
        { repository: repo },
      ),
      0,
      s.err(),
    );
    assert.match(s.err(), /^warning: cannot write .*\/trust\.yaml: /);
    assert.equal(resultOf(await waitForEnd(home, s.out().trim())), "success");
  } finally {
    await chmod(home, 0o755).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("--detach asks before the run owner starts; denying creates no run folder", async () => {
  const { repo, home, env } = await setup();
  const source = "git+https://user:secret@git.example.test/acme/loops@main#subdirectory=loops";
  const fixture = await makeGitFixture(
    { "loops/manifest.yaml": markerManifest("no-run") },
    "acme/loops",
    "https://user:secret@git.example.test/",
  );
  try {
    const sha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository })
    ).stdout.trim();
    const s = session(true, 2, async (header) => {
      assert.match(header, /^DANGER {2}This Loopfile can run any shell command/);
      assert.ok(
        header.includes("Source   git+https://git.example.test/acme/loops@main#subdirectory=loops"),
      );
      assert.ok(
        header.includes(
          `Full text: loopfile unpack git+https://git.example.test/acme/loops@${sha.slice(0, 7)}#subdirectory=loops ./look`,
        ),
      );
      assert.match(header, /Steps {4}1/);
      assert.equal(header.includes("\x1b"), false);
      assert.doesNotMatch(header, /user|secret/);
      await assert.rejects(stat(join(home, "runs")));
      return 2;
    });
    assert.equal(
      await launchCommand(
        [source, "-d"],
        cli,
        s.io,
        { ...env, ...fixture.env, NO_COLOR: "1" },
        {
          repository: repo,
        },
      ),
      2,
    );
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("a remote manifest failure cleans its fetched folder", async () => {
  const { base, repo, home, env } = await setup("formatVersion: 1\nsteps: []\n");
  const fixture = await makeGitFixture({ "manifest.yaml": "formatVersion: 1\nsteps: []\n" });
  const tmp = await privateTmp(base);
  try {
    const s = session();
    assert.equal(
      await launchCommand(
        ["github:acme/loops", "--trust"],
        cli,
        s.io,
        { ...env, ...fixture.env, TMPDIR: tmp },
        { repository: repo },
      ),
      1,
    );
    assert.deepEqual(await remoteFolders(tmp), []);
    await assert.rejects(stat(join(home, "runs")));
  } finally {
    await fixture.cleanup();
  }
});

test("a Materialized Loopfile can start a run with a chosen ID", async () => {
  const { repo, source, home, env } = await setup();
  const runId = "20260922-180000-from-code";
  const started = await startRun({
    source,
    repository: repo,
    inputs: { issue: "42" },
    runId,
    loopId: "loop-20260922-180000-parent",
    loopIndex: 1,
    cli,
    env,
  });
  assert.deepEqual(started, { ok: true, runId });
  const events = await waitForEnd(home, runId);
  assert.equal(resultOf(events), "success");
  const created = events[0];
  assert.deepEqual(
    created?.type === "run.created"
      ? { loopId: created.loopId, loopIndex: created.loopIndex }
      : undefined,
    { loopId: "loop-20260922-180000-parent", loopIndex: 1 },
  );
  assert.ok(await stat(runPaths(home, runId).root));
});

test("a run started from code rejects bad inputs before making its run folder", async () => {
  const { repo, source, home, env } = await setup();
  const started = await startRun({
    source,
    repository: repo,
    inputs: {},
    runId: "20260922-180000-bad-input",
    cli,
    env,
  });
  assert.equal(started.ok, false);
  if (!started.ok) {
    assert.deepEqual(started.failure.messages, ["missing --input issue: The issue number"]);
    assert.equal(started.failure.code, "bad_argument");
  }
  await assert.rejects(stat(join(home, "runs")));
});

test("a thin manifest from stdin starts a run and materializes the manifest", async () => {
  const { repo, home, env } = await setup();
  const s = session();
  const code = await launchCommand(["-", "-d", "--input", "issue=42"], cli, s.io, env, {
    repository: repo,
    readStdin: async () => Buffer.from(MANIFEST),
  });
  assert.equal(code, 0, s.err());
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  assert.equal(resultOf(await waitForEnd(home, runId)), "success");
  assert.equal(await readFile(join(paths.loopfile, "manifest.yaml"), "utf8"), MANIFEST);
});

test("an outdated manifest from stdin is rejected without an uncaught error", async () => {
  const { repo, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand(["-"], cli, s.io, env, {
      repository: repo,
      readStdin: async () => Buffer.from("formatVersion: 0\nsteps: []\n"),
    }),
    1,
  );
  assert.match(s.err(), /missing upgrade step from format version 0/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a directory, a thin .loop and a packed .loop run the same and give input.issue to the first step", async () => {
  const { base, repo, source, home, env } = await setup();
  const thin = join(base, "thin.loop");
  await writeFile(thin, MANIFEST);
  const packed = join(base, "packed.loop");
  await writeArchive(source, packed);

  const shapes: string[][] = [];
  for (const input of [source, thin, packed]) {
    const { events, paths } = await detached(input, home, env, repo);
    assert.equal(resultOf(events), "success", input);
    shapes.push(events.map((event) => event.type));
    // The value is text, read by the step, and never appears in the event log.
    const created = events[0];
    assert.equal(created?.type, "run.created");
    assert.deepEqual(
      created?.type === "run.created" && created.inputs.map(({ name, size }) => [name, size]),
      [["issue", 2]],
    );
    assert.equal(await readFile(join(paths.inputs, "issue"), "utf8"), "42");
    assert.doesNotMatch(await readFile(paths.events, "utf8"), /"42"/);
  }
  assert.deepEqual(shapes[1], shapes[0]);
  assert.deepEqual(shapes[2], shapes[0]);
});

test("Manifest and CLI empty mode start steps in a clean, Target-free workspace", async () => {
  const manifest = (mode: string) => `formatVersion: 1
workspace: ${mode}
steps:
  - id: inspect
    kind: command
    run: 'test -z "$(find . -mindepth 1 -maxdepth 1 -print -quit)" && printf "%s\\n%s\\n%s\\n" "$PWD" "$LOOPFILE_WORKSPACE" "$LOOPFILE_SCRATCH" > context.txt && env > env.txt'
`;
  const { repo, source, home, env } = await setup(manifest("empty"));
  await writeFile(join(repo, "CLAUDE.md"), "Target instructions\n");
  await mkdir(join(repo, ".claude", "skills"), { recursive: true });
  await writeFile(join(repo, ".claude", "settings.json"), "{}\n");
  await writeFile(join(repo, ".claude", "settings.local.json"), "{}\n");
  await writeFile(join(repo, ".claude", "skills", "skill.md"), "Target skill\n");
  await writeFile(join(repo, ".claude", "hooks.json"), "{}\n");
  const gitBin = join(home, "bin");
  const gitCalled = join(home, "git-called");
  await mkdir(gitBin, { recursive: true });
  const fakeGit = join(gitBin, "git");
  await writeFile(fakeGit, '#!/bin/sh\nprintf called > "$EMPTY_MODE_GIT_SENTINEL"\nexit 1\n');
  await chmod(fakeGit, 0o755);

  for (const [manifestMode, args] of [
    ["empty", [source, "-d"]],
    ["isolate", [source, "--workspace", "empty", "-d"]],
  ] as const) {
    await writeFile(join(source, "manifest.yaml"), manifest(manifestMode));
    const s = session();
    assert.equal(
      await launchCommand(
        args,
        cli,
        s.io,
        {
          ...env,
          PWD: repo,
          OLDPWD: repo,
          PATH: `${gitBin}${delimiter}${process.env.PATH ?? ""}`,
          EMPTY_MODE_GIT_SENTINEL: gitCalled,
        },
        { repository: join(repo, "not-a-target") },
      ),
      0,
      s.err(),
    );
    const runId = s.out().trim();
    const paths = runPaths(home, runId);
    const events = await waitForEnd(home, runId);
    const created = events[0];
    assert.equal(created?.type, "run.created");
    if (created?.type !== "run.created") throw new Error("run.created is missing");
    assert.deepEqual([created.workspaceMode, created.workspacePath], ["empty", paths.workspace]);
    for (const field of ["targetFolder", "branch", "baseCommit", "isolateKind"] as const) {
      assert.equal(Object.hasOwn(created, field), false, field);
    }
    const [cwd, workspace, scratch] = (await readFile(join(paths.workspace, "context.txt"), "utf8"))
      .trim()
      .split("\n");
    assert.deepEqual([cwd, workspace], [paths.workspace, paths.workspace]);
    assert.equal(scratch, join(paths.attempts, "001-inspect", "scratch"));
    const stepEnv = await readFile(join(paths.workspace, "env.txt"), "utf8");
    assert.equal(stepEnv.includes(repo), false);
    assert.doesNotMatch(stepEnv, /^LOOPFILE_(?:LAUNCH|TARGET)=/m);
    assert.deepEqual(await readdir(paths.workspace), ["context.txt", "env.txt"]);
  }
  await assert.rejects(stat(gitCalled), { code: "ENOENT" });
});

test("workspace here runs in the launch folder without Git and reports matching result paths", async () => {
  const manifest = `formatVersion: 1
workspace: here
steps:
  - id: inspect
    kind: command
    run: 'pwd > here.cwd; printf "%s\\n%s\\n" "$LOOPFILE_WORKSPACE" "$LOOPFILE_SCRATCH" > here.env'
`;
  const { base, repo, source, home, env } = await setup(manifest);
  const guarded = await blockGit(env, base);
  const s = session();
  assert.equal(
    await launchCommand([source, "-d"], cli, s.io, guarded.env, { repository: repo }),
    0,
    s.err(),
  );
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  assert.equal(s.err(), `started: ${runId}\nworkspace: here · ${repo}\n`);

  const events = await waitForEnd(home, runId);
  const created = events[0];
  assert.equal(created?.type, "run.created");
  if (created?.type !== "run.created") throw new Error("run.created is missing");
  assert.deepEqual(
    [created.workspaceMode, created.targetFolder, created.workspacePath],
    ["here", repo, repo],
  );
  for (const field of ["branch", "baseCommit", "isolateKind"] as const) {
    assert.equal(Object.hasOwn(created, field), false);
  }
  await assert.rejects(stat(paths.workspace), { code: "ENOENT" });
  assert.equal((await readFile(join(repo, "here.cwd"), "utf8")).trim(), repo);
  assert.deepEqual((await readFile(join(repo, "here.env"), "utf8")).trim().split("\n"), [
    repo,
    join(paths.attempts, "001-inspect", "scratch"),
  ]);
  let result = "";
  assert.equal(
    await resultCommand(
      ["result", runId],
      (text) => (result += text),
      () => {},
      guarded.env,
    ),
    0,
  );
  assert.match(result, new RegExp(`^target +${repo}$`, "m"));
  assert.match(result, new RegExp(`^workspace +here · ${repo}$`, "m"));
  assert.doesNotMatch(result, /^branch(?:\s|$)/m);
  assert.doesNotMatch(result, /^base commit(?:\s|$)/m);
  await assert.rejects(readFile(guarded.calls), { code: "ENOENT" });
});

test("--workspace here overrides the Manifest and two runs start in one folder", async () => {
  const manifest = `formatVersion: 1
workspace: isolate
steps:
  - id: wait
    kind: command
    run: 'sleep 0.5; echo done >> concurrent.txt'
`;
  const { base, repo, source, home, env } = await setup(manifest);
  const guarded = await blockGit(env, base);
  const runIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const s = session();
    assert.equal(
      await launchCommand([source, "--workspace", "here", "-d"], cli, s.io, guarded.env, {
        repository: repo,
      }),
      0,
      s.err(),
    );
    const runId = s.out().trim();
    runIds.push(runId);
    assert.equal(s.err(), `started: ${runId}\nworkspace: here · ${repo}\n`);
  }
  assert.notEqual(runIds[0], runIds[1]);
  const events = await Promise.all(runIds.map((runId) => waitForEnd(home, runId)));
  for (const runEvents of events) {
    const created = runEvents[0];
    assert.equal(created?.type === "run.created" && created.workspaceMode, "here");
    assert.equal(created?.type === "run.created" && created.workspacePath, repo);
  }
  assert.equal((await readFile(join(repo, "concurrent.txt"), "utf8")).trim().split("\n").length, 2);
  await assert.rejects(readFile(guarded.calls), { code: "ENOENT" });
});

test("a nested Git launch records its top level and creates an isolate worktree branch", async () => {
  const manifest = MANIFEST.replace("formatVersion: 1", "formatVersion: 1\nworkspace: isolate");
  const { repo, source, home, env } = await setup(manifest);
  const launchFolder = join(repo, "nested");
  await mkdir(launchFolder);
  const s = session();
  assert.equal(
    await launchCommand(
      [source, "--workspace", "isolate", "--input", "issue=42", "-d"],
      cli,
      s.io,
      env,
      { repository: launchFolder },
    ),
    0,
    s.err(),
  );
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  assert.equal(
    s.err(),
    `started: ${runId}\nworkspace: isolate · ${paths.workspace}\nbranch: loopfile/${runId}\n`,
  );
  const events = await waitForEnd(home, runId);
  const created = events.find((event) => event.type === "run.created");
  assert.deepEqual(
    created?.type === "run.created"
      ? [created.targetFolder, created.workspacePath, created.workspaceMode, created.isolateKind]
      : undefined,
    [repo, paths.workspace, "isolate", "worktree"],
  );
  if (created?.type !== "run.created") throw new Error("run.created is missing");
  assert.equal(created.branch, `loopfile/${runId}`);
  assert.ok(created.baseCommit);
  assert.equal(
    (await run("git", ["branch", "--list", `loopfile/${runId}`], { cwd: repo })).stdout
      .trim()
      .split(/\s+/)
      .at(-1),
    `loopfile/${runId}`,
  );
});

test("launch outside Git copies the nested launch folder, including ignored files", async () => {
  const { base, source, env } = await setup(COPY_MANIFEST);
  const parent = join(base, "plain-parent");
  const target = join(parent, "launch-folder");
  await mkdir(parent);
  await makeCopyTarget(target, false, false);
  await writeFile(join(parent, "outside.txt"), "not the Target folder\n");

  const { paths } = await launchCopy(source, target, env);
  await assert.rejects(stat(join(paths.workspace, "outside.txt")));
});

test("launch in a Git repository with no commits creates a complete copy", async () => {
  const { base, source, env } = await setup(COPY_MANIFEST);
  const target = join(base, "unborn-target");
  await makeCopyTarget(target, true, false);

  const { paths } = await launchCopy(source, target, env);
  assert.ok(await stat(paths.workspace));
});

test("launch without a git binary creates a complete copy including ignored files", async () => {
  const { base, source, env } = await setup(COPY_MANIFEST);
  const target = join(base, "no-git-target");
  await makeCopyTarget(target, true, true);
  const bin = join(base, "no-git-bin");
  await mkdir(bin);
  await symlink("/bin/sh", join(bin, "sh"));
  const noGitEnv = { ...env, PATH: bin };

  const { paths } = await launchCopy(source, target, noGitEnv, true);
  assert.deepEqual(await readdir(bin), ["sh"]);
  assert.ok(await stat(paths.workspace));
});

test("copy results hide branch facts but keep empty JSON fields", async () => {
  const { base, source, env } = await setup(COPY_MANIFEST);
  const target = join(base, "result-target");
  await makeCopyTarget(target, false, false);
  const { runId } = await launchCopy(source, target, env);

  let text = "";
  assert.equal(
    await resultCommand(
      ["result", runId],
      (value) => (text += value),
      () => {},
      env,
    ),
    0,
  );
  assert.match(text, new RegExp(`^target +${target}$`, "m"));
  assert.doesNotMatch(text, /^branch(?:\s|$)/m);
  assert.doesNotMatch(text, /^base commit(?:\s|$)/m);

  let json = "";
  assert.equal(
    await resultCommand(
      ["result", runId, "--json"],
      (value) => (json += value),
      () => {},
      env,
    ),
    0,
  );
  const result = JSON.parse(json) as { branch: string; baseCommit: string };
  assert.equal(result.branch, "");
  assert.equal(result.baseCommit, "");
});

test("launch rejects unsupported workspace modes before making a run", async () => {
  const { repo, source, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand([source, "--workspace", "not-a-mode", "-d"], cli, s.io, env, {
      repository: repo,
    }),
    2,
  );
  assert.match(s.err(), /--workspace must be one of: isolate, here, empty/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a validation error stops before any run folder is made", async () => {
  const { repo, source, home, env } = await setup("formatVersion: 1\nsteps: []\n");
  const s = session();
  const code = await launchCommand([source], cli, s.io, env, { repository: repo });
  assert.equal(code, 1);
  assert.match(s.err(), /steps/);
  await assert.rejects(stat(join(home, "runs")));
});

test("an outdated manifest stops at the upgrade check before any run folder is made", async () => {
  const { repo, source, home, env } = await setup("formatVersion: 0\nsteps: []\n");
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 1);
  assert.match(s.err(), /missing upgrade step from format version 0/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch refusal prints one error line per manifest problem with its location", async () => {
  const { repo, source, home, env } = await setup(`formatVersion: 1
name: invalid
maxTransitions: 0
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 1);
  assert.deepEqual(
    s
      .err()
      .split("\n")
      .filter((line) => line.startsWith("error: ")),
    [
      "error: line 2: name: unknown field `name`",
      "error: line 3: maxTransitions: maxTransitions must be an integer of 1 or more",
    ],
  );
  assert.match(s.err(), /\ncode: invalid_manifest\n/);
  await assert.rejects(stat(join(home, "runs")));
});

test("a bad --input is refused before launch", async () => {
  const { repo, source, home, env } = await setup();
  const cases: [string[], RegExp][] = [
    [["--input", "issue"], /<name>=<value>/],
    [["--input", "Issue=1"], /must match/],
    [["--input", "issue=1", "--input", "issue=2"], /more than once/],
  ];
  for (const [flags, message] of cases) {
    const s = session();
    const code = await launchCommand([source, ...flags], cli, s.io, env, { repository: repo });
    assert.equal(code, 2, flags.join(" "));
    assert.match(s.err(), message);
  }
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch reports each missing input on its own error line", async () => {
  const { repo, source, home, env } = await setup(`formatVersion: 1
inputs:
  issue: the issue number
  task: the issue number, title and body
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 2);
  assert.equal(
    s.err(),
    "error: missing --input issue: the issue number\n" +
      "error: missing --input task: the issue number, title and body\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>.\n",
  );
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch input failure names optional inputs and their defaults", async () => {
  const { repo, source, home, env } = await setup(`formatVersion: 1
inputs:
  issue: the issue number
  merge:
    description: whether to merge
    default: "no"
  ci:
    description: whether CI is required
    default: "yes"
steps:
  - id: work
    kind: command
    run: 'true'
`);
  const s = session();
  assert.equal(await launchCommand([source], cli, s.io, env, { repository: repo }), 2);
  assert.equal(
    s.err(),
    "error: missing --input issue: the issue number\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>. Optional inputs: merge (default: no), ci (default: yes)\n",
  );
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch reports each undeclared input on its own error line", async () => {
  const { repo, source, home, env } = await setup();
  const s = session();
  assert.equal(
    await launchCommand([source, "--input", "other=1", "--input", "another=2"], cli, s.io, env, {
      repository: repo,
    }),
    2,
  );
  assert.equal(
    s.err(),
    "error: --input other is not declared by the Loopfile. Declared inputs: issue.\n" +
      "error: --input another is not declared by the Loopfile. Declared inputs: issue.\n" +
      "code: bad_argument\n" +
      "help: Give each with --input <name>=<value>.\n",
  );
  await assert.rejects(stat(join(home, "runs")));
});

test("a launch stores an omitted default as an input, and a given value wins", async () => {
  const manifest = `formatVersion: 1
inputs:
  issue: The issue number
  merge:
    description: Whether to merge
    default: "no"
steps:
  - id: work
    kind: command
    run: 'test -n "$(node ${cli} data get input.merge)"'
`;
  for (const [extra, expected, size] of [
    [[], "no", 2],
    [["--input", "merge=yes"], "yes", 3],
  ] as const) {
    const { repo, source, home, env } = await setup(manifest);
    const s = session();
    assert.equal(
      await launchCommand([source, "-d", "--input", "issue=42", ...extra], cli, s.io, env, {
        repository: repo,
      }),
      0,
      s.err(),
    );
    const runId = s.out().trim();
    const events = await waitForEnd(home, runId);
    assert.equal(resultOf(events), "success");
    const paths = runPaths(home, runId);
    assert.equal(await readFile(join(paths.inputs, "merge"), "utf8"), expected);
    const created = events[0];
    assert.deepEqual(
      created?.type === "run.created" &&
        created.inputs.map(({ name, size: bytes }) => [name, bytes]),
      [
        ["issue", 2],
        ["merge", size],
      ],
    );
  }
});

test("no source, two sources and a missing path are refused", async () => {
  const { repo, home, env } = await setup();
  const opts = { repository: repo };
  const none = session();
  assert.equal(await launchCommand(["-d"], cli, none.io, env, opts), 2);
  assert.match(none.err(), /Usage: loopfile/);
  const two = session();
  assert.equal(await launchCommand(["a", "b"], cli, two.io, env, opts), 2);
  const bad = session();
  assert.equal(await launchCommand(["--nope", "a"], cli, bad.io, env, opts), 2);
  const missing = session();
  assert.equal(await launchCommand([join(home, "nope")], cli, missing.io, env, opts), 2);
  assert.match(missing.err(), /unknown command '.*nope'/);
});

test("a source that is neither a directory nor text is an input error, not an unknown command", async () => {
  const { base, repo, env } = await setup();
  const empty = join(base, "empty.loop");
  await writeFile(empty, "");
  const s = session();
  assert.equal(await launchCommand([empty], cli, s.io, env, { repository: repo }), 1);
  assert.match(s.err(), /file is empty/);
});

test("a run owner that exits before ready exits 2 and gives the end of owner.log", async () => {
  const { base, repo, source, home, env } = await setup();
  const fakeOwner = join(base, "fake-owner.js");
  await writeFile(fakeOwner, 'console.error("fake owner failed"); process.exit(1);\n');
  const s = session();
  const code = await launchCommand([source, "-d", "--input", "issue=1"], fakeOwner, s.io, env, {
    repository: repo,
  });
  assert.equal(code, 2);
  assert.equal(s.out(), "");
  assert.match(s.err(), /exited before it was ready/);
  assert.match(s.err(), /owner\.log/);
  const [runId] = await readdir(join(home, "runs"));
  assert.match(
    await readFile(runPaths(home, runId as string).ownerLog, "utf8"),
    /fake owner failed/,
  );
});

test("a run folder that cannot be made stops the launch", async () => {
  const { repo, source, home, env } = await setup();
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "runs"), "a file, not a folder");
  const s = session();
  assert.equal(
    await launchCommand([source, "-d", "--input", "issue=1"], cli, s.io, env, { repository: repo }),
    1,
  );
  assert.match(s.err(), /run folder already exists/);
});

test("a run owner that never says ready is stopped after the wait and exits 2", async () => {
  const { repo, source, env } = await setup();
  const s = session();
  const code = await launchCommand([source, "-d", "--input", "issue=1"], cli, s.io, env, {
    repository: repo,
    readyTimeoutMs: 1,
  });
  assert.equal(code, 2);
  assert.match(s.err(), /did not say ready in time/);
});

test("without -d the monitor attaches, and d leaves the run running to its end", async () => {
  const { repo, source, home, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: slow\n    kind: command\n    run: sleep 1\n",
  );
  const s = session(true);
  const launched = launchCommand([source], cli, s.io, env, {
    repository: repo,
    monitor: { pollIntervalMs: 50 },
  });
  // Press d only once the monitor has drawn. A fixed wait lost the race on a
  // loaded machine, and the key reached no monitor.
  for (let tries = 0; tries < 200 && !/d detach/.test(s.screen.text()); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  s.screen.input.write("d");
  assert.equal(await launched, 0);
  assert.match(s.screen.text(), /d detach/);
  const [runId] = await readdir(join(home, "runs"));
  const events = await waitForEnd(home, runId as string);
  assert.equal(resultOf(events), "success");
});

test("without a terminal the launch prints the run ID, waits for the end and exits 0 when it completed", async () => {
  const { repo, source, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: quick\n    kind: command\n    run: 'true'\n",
  );
  const s = session(false);
  const code = await launchCommand([source], cli, s.io, env, {
    repository: repo,
    monitor: { pollIntervalMs: 50 },
  });
  assert.equal(code, 0, s.err());
  const [runId, ...rest] = s.out().split("\n");
  assert.match(runId as string, /^\d{8}-\d{6}-/);
  assert.deepEqual(rest, [""]);
  assert.match(s.err(), new RegExp(`started: ${runId}\\n`));
  assert.match(s.err(), new RegExp(`ended: ${runId} completed\\n`));
  assert.equal(s.screen.text(), "");
});

test("without a terminal a failed run exits 1 and says on stderr where to look", async () => {
  const { repo, source, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: quick\n    kind: command\n    run: 'false'\n",
  );
  const s = session(false);
  const code = await launchCommand([source], cli, s.io, env, {
    repository: repo,
    monitor: { pollIntervalMs: 50 },
  });
  assert.equal(code, 1);
  const runId = s.out().split("\n")[0] as string;
  assert.equal(s.out(), `${runId}\n`);
  assert.match(s.err(), new RegExp(`^started: ${runId}\\n`));
  assert.match(s.err(), /error: ["']?run .* failed: /);
  assert.match(s.err(), /\ncode: operation_failed\n/);
  assert.match(s.err(), new RegExp(`loopfile logs ${runId}`));
  assert.match(s.err(), new RegExp(`loopfile status ${runId} --json`));
});

test("the run owner has its own session, so closing the terminal does not reach it", async () => {
  const { repo, source, home, env } = await setup(
    "formatVersion: 1\nsteps:\n  - id: slow\n    kind: command\n    run: sleep 2\n",
  );
  const s = session();
  assert.equal(await launchCommand([source, "-d"], cli, s.io, env, { repository: repo }), 0);
  const runId = s.out().trim();
  const paths = runPaths(home, runId);
  const started = parseEventLog(await readFile(paths.events, "utf8")).find(
    (event) => event.type === "owner.started",
  );
  const pid = started?.type === "owner.started" ? started.pid : 0;
  assert.ok(pid > 0);
  const sid = async (id: number) =>
    (await run("ps", ["-o", "sid=", "-p", String(id)])).stdout.trim();
  // A session leader: its session ID is its own pid, and not ours.
  assert.equal(await sid(pid), String(pid));
  assert.notEqual(await sid(process.pid), String(pid));
  await waitForEnd(home, runId);
});

test("an in-process launch records its loop link in the event, status and result", async () => {
  const { repo, source, home, env } = await setup();
  const capture = () => {
    let text = "";
    return {
      write: (chunk: string) => {
        text += chunk;
      },
      text: () => text,
    };
  };
  const s = session();
  assert.equal(
    await launchCommand([source, "-d", "--input", "issue=42"], cli, s.io, env, {
      repository: repo,
      loopId: "loop-20260922-105306-qfn3",
      loopIndex: 3,
    }),
    0,
    s.err(),
  );
  const runId = s.out().trim();
  const events = await waitForEnd(home, runId);
  const created = events[0];
  assert.deepEqual(
    created?.type === "run.created"
      ? { loopId: created.loopId, loopIndex: created.loopIndex }
      : undefined,
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );

  const paths = runPaths(home, runId);
  const statusFile = JSON.parse(await readFile(paths.status, "utf8")) as {
    loopId: string;
    loopIndex: number;
  };
  assert.deepEqual(
    { loopId: statusFile.loopId, loopIndex: statusFile.loopIndex },
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );

  const status = capture();
  assert.equal(await statusCommand(["status", runId], status.write, capture().write, env), 0);
  assert.match(status.text(), /^loop: loop-20260922-105306-qfn3 \(run 3\)$/m);
  const statusJson = capture();
  assert.equal(
    await statusCommand(["status", runId, "--json"], statusJson.write, capture().write, env),
    0,
  );
  const statusBody = JSON.parse(statusJson.text()) as { loopId: string; loopIndex: number };
  assert.deepEqual(
    { loopId: statusBody.loopId, loopIndex: statusBody.loopIndex },
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );

  const result = capture();
  assert.equal(await resultCommand(["result", runId], result.write, result.write, env), 0);
  assert.match(result.text(), /^loop: loop-20260922-105306-qfn3 \(run 3\)$/m);
  const resultJson = capture();
  assert.equal(
    await resultCommand(["result", runId, "--json"], resultJson.write, resultJson.write, env),
    0,
  );
  const resultBody = JSON.parse(resultJson.text()) as { loopId: string; loopIndex: number };
  assert.deepEqual(
    { loopId: resultBody.loopId, loopIndex: resultBody.loopIndex },
    { loopId: "loop-20260922-105306-qfn3", loopIndex: 3 },
  );
});

test("the printed run ID is found by status, tail and list", async () => {
  const { repo, source, home, env } = await setup();
  const { runId } = await detached(source, home, env, repo);
  const capture = () => {
    let text = "";
    return {
      write: (chunk: string) => {
        text += chunk;
      },
      text: () => text,
    };
  };

  const status = capture();
  const statusErr = capture();
  assert.equal(await statusCommand(["status", runId], status.write, statusErr.write, env), 0);
  assert.match(status.text(), new RegExp(runId));
  assert.doesNotMatch(status.text(), /^loop:/m);

  const statusJson = capture();
  assert.equal(
    await statusCommand(["status", runId, "--json"], statusJson.write, statusErr.write, env),
    0,
  );
  const plainStatus = JSON.parse(statusJson.text()) as {
    loopId: string | null;
    loopIndex: number | null;
  };
  assert.deepEqual(
    { loopId: plainStatus.loopId, loopIndex: plainStatus.loopIndex },
    { loopId: null, loopIndex: null },
  );
  const result = capture();
  const resultErr = capture();
  assert.equal(await resultCommand(["result", runId], result.write, resultErr.write, env), 0);
  assert.doesNotMatch(result.text(), /^loop:/m);
  const resultJson = capture();
  assert.equal(
    await resultCommand(["result", runId, "--json"], resultJson.write, resultErr.write, env),
    0,
  );
  const plainResult = JSON.parse(resultJson.text()) as {
    loopId: string | null;
    loopIndex: number | null;
  };
  assert.deepEqual(
    { loopId: plainResult.loopId, loopIndex: plainResult.loopIndex },
    { loopId: null, loopIndex: null },
  );

  const tail = capture();
  const tailErr = capture();
  assert.equal(
    await tailCommand(["tail", runId], tail.write, tailErr.write, env),
    0,
    tailErr.text(),
  );
  assert.notEqual(tail.text(), "");

  const list = capture();
  assert.equal(await listCommand(["list", "--json"], list.write, capture().write, env), 0);
  assert.match(list.text(), new RegExp(runId));
});
