import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRunDirectory,
  loopfileHome,
  loopPaths,
  newLoopId,
  newRunId,
  RunDirectoryError,
  runPaths,
} from "./run-directory.ts";

test("home is ~/.loopfile unless LOOPFILE_HOME says otherwise", () => {
  assert.equal(loopfileHome({ HOME: "/home/ada" }), "/home/ada/.loopfile");
  assert.equal(loopfileHome({ HOME: "/home/ada", LOOPFILE_HOME: "/tmp/lf" }), "/tmp/lf");
});

test("an empty LOOPFILE_HOME is no override", () => {
  assert.equal(loopfileHome({ HOME: "/home/ada", LOOPFILE_HOME: "" }), "/home/ada/.loopfile");
});

test("a relative LOOPFILE_HOME becomes absolute", () => {
  assert.equal(loopfileHome({ HOME: "/home/ada", LOOPFILE_HOME: "lf" }), join(process.cwd(), "lf"));
});

test("a loop ID uses the run timestamp and prefix", () => {
  const id = newLoopId(new Date("2026-09-17T16:03:44.500Z"));
  assert.match(id, /^loop-20260917-160344-[a-z2-7]{4}$/);
});

test("every loop file sits under the loop folder", () => {
  const paths = loopPaths("/tmp/lf", "loop-20260917-160344-k3f9");
  assert.deepEqual(paths, {
    root: "/tmp/lf/loops/loop-20260917-160344-k3f9",
    events: "/tmp/lf/loops/loop-20260917-160344-k3f9/events.jsonl",
    status: "/tmp/lf/loops/loop-20260917-160344-k3f9/status.json",
    loopfile: "/tmp/lf/loops/loop-20260917-160344-k3f9/loopfile",
    socket: "/tmp/lf/loops/loop-20260917-160344-k3f9/owner.sock",
    ownerLog: "/tmp/lf/loops/loop-20260917-160344-k3f9/owner.log",
  });
});

test("every run file sits under the run folder", () => {
  const paths = runPaths("/tmp/lf", "20260917-160344-k3f9");
  assert.deepEqual(paths, {
    root: "/tmp/lf/runs/20260917-160344-k3f9",
    events: "/tmp/lf/runs/20260917-160344-k3f9/events.jsonl",
    status: "/tmp/lf/runs/20260917-160344-k3f9/status.json",
    activity: "/tmp/lf/runs/20260917-160344-k3f9/activity.log",
    socket: "/tmp/lf/runs/20260917-160344-k3f9/owner.sock",
    ownerLog: "/tmp/lf/runs/20260917-160344-k3f9/owner.log",
    attempts: "/tmp/lf/runs/20260917-160344-k3f9/attempts",
    workspace: "/tmp/lf/runs/20260917-160344-k3f9/workspace",
    loopfile: "/tmp/lf/runs/20260917-160344-k3f9/loopfile",
    prompts: "/tmp/lf/runs/20260917-160344-k3f9/prompts",
    inputs: "/tmp/lf/runs/20260917-160344-k3f9/inputs",
  });
});

test("a run ID reads as the UTC second it was made in", () => {
  const id = newRunId(new Date("2026-09-17T16:03:44.500Z"));
  assert.match(id, /^20260917-160344-[a-z2-7]{4}$/);
});

test("two run IDs made in the same second differ", () => {
  const at = new Date("2026-09-17T16:03:44Z");
  const ids = new Set(Array.from({ length: 200 }, () => newRunId(at)));
  assert.ok(ids.size > 190, `expected near-unique IDs, got ${ids.size} of 200`);
});

const scratch = await mkdtemp(join(tmpdir(), "loopfile-run-"));
const repository = join(scratch, "repo");
await mkdir(repository);

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

test("a run gets a fresh folder of its own", async () => {
  const home = join(scratch, "home");
  const paths = await createRunDirectory({
    home,
    runId: newRunId(),
    targetRepository: repository,
    stepIds: ["build", "review"],
  });
  assert.ok(await isDirectory(paths.root));
  assert.equal(paths.events, join(paths.root, "events.jsonl"));
});

test("the run folder has an empty owner.log for the spawn redirect", async () => {
  const home = join(scratch, "owner-log");
  const paths = await createRunDirectory({
    home,
    runId: newRunId(),
    targetRepository: repository,
    stepIds: ["build"],
  });
  assert.equal((await stat(paths.ownerLog)).size, 0);
});

test("the workspace path is given but not made, because #16 owns the worktree", async () => {
  const home = join(scratch, "workspace");
  const paths = await createRunDirectory({
    home,
    runId: newRunId(),
    targetRepository: repository,
    stepIds: ["build"],
  });
  assert.equal(paths.workspace, join(paths.root, "workspace"));
  assert.equal(await isDirectory(paths.workspace), false);
});

test("two runs started in the same moment get different folders", async () => {
  const home = join(scratch, "same-moment");
  const at = new Date();
  const [first, second] = await Promise.all(
    [0, 1].map(() =>
      createRunDirectory({
        home,
        runId: newRunId(at),
        targetRepository: repository,
        stepIds: ["build"],
      }),
    ),
  );
  assert.notEqual(first?.root, second?.root);
});

test("an existing run folder is never reused", async () => {
  const home = join(scratch, "reuse");
  const runId = newRunId();
  const options = { home, runId, targetRepository: repository, stepIds: ["build"] };
  await createRunDirectory(options);
  await assert.rejects(createRunDirectory(options), (error: Error) => {
    assert.ok(error instanceof RunDirectoryError);
    assert.match(error.message, /already exists/);
    return true;
  });
});

test("LOOPFILE_HOME moves every run file", async () => {
  const home = join(scratch, "elsewhere");
  const paths = await createRunDirectory({
    home,
    runId: newRunId(),
    targetRepository: repository,
    stepIds: ["build"],
  });
  for (const path of Object.values(paths)) assert.ok(path.startsWith(`${home}/runs/`), path);
  assert.ok(await isDirectory(paths.root));
});

test("a home inside the target repository is rejected and nothing is made", async () => {
  const home = join(repository, ".loopfile");
  await assert.rejects(
    createRunDirectory({
      home,
      runId: newRunId(),
      targetRepository: repository,
      stepIds: ["build"],
    }),
    (error: Error) => {
      assert.ok(error instanceof RunDirectoryError);
      assert.match(error.message, /inside the target repository/);
      return true;
    },
  );
  assert.equal(await isDirectory(home), false);
});

test("a home that is a symlink into the target repository is rejected", async () => {
  const hidden = join(repository, "hidden");
  await mkdir(hidden);
  const home = join(scratch, "link-home");
  await symlink(hidden, home);
  await assert.rejects(
    createRunDirectory({
      home,
      runId: newRunId(),
      targetRepository: repository,
      stepIds: ["build"],
    }),
    /inside the target repository/,
  );
  assert.equal(await isDirectory(join(hidden, "runs")), false);
});

test("the target repository itself as home is rejected", async () => {
  await assert.rejects(
    createRunDirectory({
      home: repository,
      runId: newRunId(),
      targetRepository: repository,
      stepIds: ["build"],
    }),
    /inside the target repository/,
  );
});

test("a socket path over the limit is rejected before the folder is made", async () => {
  const home = join(scratch, "x".repeat(120));
  await assert.rejects(
    createRunDirectory({
      home,
      runId: newRunId(),
      targetRepository: repository,
      stepIds: ["build"],
    }),
    (error: Error) => {
      assert.ok(error instanceof RunDirectoryError);
      assert.match(error.message, /over the \d+-byte limit/);
      assert.match(error.message, /LOOPFILE_HOME/);
      return true;
    },
  );
  assert.equal(await isDirectory(home), false);
});

test("the longest step ID sets the socket budget, not owner.sock", async () => {
  // This home leaves room for a short step's socket, but not a long one's.
  const home = join(scratch, "y".repeat(20));
  const shared = { home, targetRepository: repository };
  await createRunDirectory({ ...shared, runId: newRunId(), stepIds: ["fix"] });
  await assert.rejects(
    createRunDirectory({ ...shared, runId: newRunId(), stepIds: ["fix", "review-the-whole-diff"] }),
    /over the \d+-byte limit/,
  );
});

test("cleanup", async () => {
  await rm(scratch, { recursive: true, force: true });
});
