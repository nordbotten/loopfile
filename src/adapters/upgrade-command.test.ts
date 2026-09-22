import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { list } from "tar";
import type { Document } from "yaml";
import type { ManifestUpgrades } from "../application/upgrade.ts";
import { loadDirectory, loadPacked, loadThin } from "./directory-loader.ts";
import { writeArchive } from "./pack-command.ts";
import {
  checkManifestVersion,
  checkManifestVersionText,
  type UpgradeIo,
  upgradeCommand,
} from "./upgrade-command.ts";

const dir = await mkdtemp(join(tmpdir(), "loopfile-upgrade-"));
after(() => rm(dir, { recursive: true, force: true }));
let count = 0;

const UPGRADES: ManifestUpgrades = {
  0: (doc: Document) => {
    const value = doc.get("oldSteps");
    doc.delete("oldSteps");
    doc.set("steps", value);
  },
};

const BODY = `  - id: build
    kind: agent
    harness: claude
    promptFile: prompts/build.md
    on:
      done: $success
`;
const V0 = `# keep me\nformatVersion: 0\noldSteps:\n${BODY}`;
const V1 = `formatVersion: 1\nsteps:\n${BODY}`;
const V2 = `formatVersion: 2\nsteps:\n${BODY}`;
const BAD_V0 = "formatVersion: 0\noldSteps: []\n";

function makeIo(isTTY: boolean, answers: (string | null)[] = []) {
  const log = { out: "", err: "", asked: [] as string[] };
  const io: UpgradeIo = {
    out: (t) => {
      log.out += t;
    },
    err: (t) => {
      log.err += t;
    },
    isTTY,
    ask: async (q) => {
      log.asked.push(q);
      return answers.shift() ?? null;
    },
  };
  return { io, log };
}

async function folder(manifest: string): Promise<string> {
  const path = join(dir, `src${count++}`);
  await mkdir(join(path, "prompts"), { recursive: true });
  await writeFile(join(path, "prompts", "build.md"), "Build it");
  await writeFile(join(path, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(path, "manifest.yaml"), manifest);
  return path;
}

async function thin(manifest: string): Promise<string> {
  const path = join(dir, `thin${count++}.loop`);
  await writeFile(path, manifest.replace("promptFile: prompts/build.md", "prompt: Build it"));
  return path;
}

async function packed(manifest: string): Promise<string> {
  const source = await folder(manifest);
  const file = join(dir, `packed${count++}.loop`);
  await writeArchive(source, file);
  return file;
}

async function entries(file: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await list({
    file,
    onReadEntry: (entry) => {
      const chunks: Buffer[] = [];
      entry.on("data", (c: Buffer) => chunks.push(c));
      entry.on("end", () =>
        found.set(
          entry.path,
          `${entry.mode?.toString(8)}:${Buffer.concat(chunks).toString("hex")}`,
        ),
      );
    },
  });
  return found;
}

const isLoaded = (result: { status: string }) => result.status === "loaded";

test("upgrade rewrites a source directory and it loads as version 1", async () => {
  const src = await folder(V0);
  const { io, log } = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", src], io, UPGRADES), 0);
  assert.ok(isLoaded(await loadDirectory(src)));
  const text = await readFile(join(src, "manifest.yaml"), "utf8");
  assert.match(text, /^# keep me\nformatVersion: 1\nsteps:/);
  assert.equal(log.out, "");
  assert.equal(log.err, `upgraded: ${src}\nfrom: 0\nto: 1\n`);
  assert.deepEqual(log.asked, []);
  assert.deepEqual((await readdir(src)).sort(), ["manifest.yaml", "prompts", "run.sh"]);
});

test("upgrade rewrites a thin .loop and keeps its mode", async () => {
  const file = await thin(V0);
  await chmod(file, 0o640);
  assert.equal(await upgradeCommand(["upgrade", file], makeIo(false).io, UPGRADES), 0);
  assert.ok(isLoaded(await loadThin(file)));
  assert.equal((await stat(file)).mode & 0o777, 0o640);
});

test("upgrade of a symbolic link to a thin .loop keeps the link", async () => {
  const file = await thin(V0);
  const link = join(dir, `link${count++}.loop`);
  await symlink(file, link);
  assert.equal(await upgradeCommand(["upgrade", link], makeIo(false).io, UPGRADES), 0);
  assert.equal((await stat(link)).isFile(), true);
  assert.equal((await import("node:fs")).lstatSync(link).isSymbolicLink(), true);
  assert.ok(isLoaded(await loadThin(file)));
});

test("upgrade repacks a packed .loop and keeps every other entry", async () => {
  const file = await packed(V0);
  const before = await entries(file);
  assert.equal(await upgradeCommand(["upgrade", file], makeIo(false).io, UPGRADES), 0);
  assert.ok(isLoaded(await loadPacked(file)));
  const after = await entries(file);
  assert.deepEqual([...after.keys()], [...before.keys()]);
  for (const [name, value] of before) {
    if (name !== "manifest.yaml") assert.equal(after.get(name), value, name);
  }
  assert.notEqual(after.get("manifest.yaml"), before.get("manifest.yaml"));
  assert.match(after.get("run.sh") ?? "", /^755:/);
  assert.deepEqual(await readdir(dir).then((n) => n.filter((x) => x.endsWith(".tmp"))), []);
});

test("a current manifest stays byte-identical, exit 0, with the already message", async () => {
  for (const make of [folder, thin, packed]) {
    const source = await make(V1);
    const path = make === folder ? join(source, "manifest.yaml") : source;
    const before = await readFile(path);
    const { io, log } = makeIo(false);
    assert.equal(await upgradeCommand(["upgrade", source], io, UPGRADES), 0);
    assert.deepEqual(await readFile(path), before);
    assert.equal(log.out, "");
    assert.equal(log.err, `upgraded: ${source}\nfrom: 1\nto: 1\n`);
  }
});

test("upgrade - writes an upgraded manifest to stdout and confirmation to stderr", async () => {
  const old = V0.replace("promptFile: prompts/build.md", "prompt: Build it");
  const expected = old.replace("formatVersion: 0\noldSteps:", "formatVersion: 1\nsteps:");
  const { io, log } = makeIo(false);
  assert.equal(
    await upgradeCommand(["upgrade", "-"], io, UPGRADES, async () => Buffer.from(old)),
    0,
  );
  assert.equal(log.out, expected);
  assert.equal(log.err, "upgraded: -\nfrom: 0\nto: 1\n");
});

test("upgrade - returns a current manifest byte for byte", async () => {
  const current = `# keep this
formatVersion: 1
steps:
  - id: run
    kind: command
    run: "true"

`;
  const { io, log } = makeIo(false);
  assert.equal(
    await upgradeCommand(["upgrade", "-"], io, UPGRADES, async () => Buffer.from(current)),
    0,
  );
  assert.equal(log.out, current);
  assert.equal(log.err, "upgraded: -\nfrom: 1\nto: 1\n");
});

test("a current but invalid manifest exits 1 with the loader errors", async () => {
  const src = await folder("formatVersion: 1\nsteps: []\n");
  const { io, log } = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", src], io, UPGRADES), 1);
  assert.match(log.err, /steps/);
  assert.match(log.err, /\ncode: invalid_manifest\n/);
  assert.match(log.err, /\nhelp: /);
  assert.equal(log.out, "");
});

test("a newer version gives the upgrade loopfile error, exit 1, no change", async () => {
  const src = await folder(V2);
  const before = await readFile(join(src, "manifest.yaml"));
  const { io, log } = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", src], io, UPGRADES), 1);
  assert.match(log.err, /upgrade loopfile/);
  assert.deepEqual(await readFile(join(src, "manifest.yaml")), before);
});

test("an upgrade that makes an invalid manifest writes nothing", async () => {
  const src = await folder(BAD_V0);
  const { io, log } = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", src], io, UPGRADES), 1);
  assert.match(log.err, /upgraded manifest is not valid/);
  assert.equal(await readFile(join(src, "manifest.yaml"), "utf8"), BAD_V0);
  assert.equal(log.out, "");
});

test("a manifest below the released format versions fails as an operation error", async () => {
  const src = await folder(V0);
  const { io, log } = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", src], io), 1);
  assert.match(log.err, /missing upgrade step from format version 0/);
  assert.match(log.err, /\ncode: operation_failed\n/);
  assert.equal(await readFile(join(src, "manifest.yaml"), "utf8"), V0);
});

test("a folder in the way of the temporary file fails the write and changes nothing", async () => {
  const src = await folder(V0);
  await mkdir(join(src, "manifest.yaml.upgrade.tmp"));
  const { io, log } = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", src], io, UPGRADES), 1);
  assert.equal(await readFile(join(src, "manifest.yaml"), "utf8"), V0);
  assert.match(log.err, /^error: /);
  assert.match(log.err, /\ncode: operation_failed\n/);
  assert.equal((await stat(join(src, "manifest.yaml.upgrade.tmp"))).isDirectory(), true);
});

test("a missing source and a wrong argument count are reported", async () => {
  const missing = makeIo(false);
  assert.equal(await upgradeCommand(["upgrade", join(dir, "nope")], missing.io, UPGRADES), 2);
  assert.match(missing.log.err, /no such file/);
  assert.match(missing.log.err, /\ncode: bad_argument\n/);
  for (const argv of [["upgrade"], ["upgrade", "a", "b"], ["upgrade", "--bogus"]]) {
    const { io, log } = makeIo(false);
    assert.equal(await upgradeCommand(argv, io, UPGRADES), 2);
    assert.match(log.err, /^error: upgrade takes one source/);
    assert.match(log.err, /\ncode: bad_argument\n/);
    assert.match(log.err, /\nhelp: Usage: loopfile upgrade <source>/);
  }
});

test("check with no terminal refuses every file source with an operator failure", async () => {
  for (const make of [folder, thin, packed]) {
    const src = await make(V0);
    const { io, log } = makeIo(false, ["y"]);
    assert.deepEqual(await checkManifestVersion(src, io, UPGRADES), { ok: false, exitCode: 2 });
    assert.equal(
      log.err,
      `error: Manifest is outdated\ncode: manifest_outdated\nhelp: loopfile upgrade ${src}\n`,
    );
    assert.deepEqual(log.asked, []);
    assert.equal(log.out, "");
    const manifest = make === folder ? join(src, "manifest.yaml") : src;
    if (make !== packed)
      assert.equal(
        await readFile(manifest, "utf8"),
        make === folder ? V0 : V0.replace("promptFile: prompts/build.md", "prompt: Build it"),
      );
  }
});

test("an outdated stdin manifest is refused with the stdin upgrade filter", () => {
  const { io, log } = makeIo(false, ["y"]);
  assert.deepEqual(checkManifestVersionText("-", V0, io, UPGRADES), { ok: false, exitCode: 2 });
  assert.equal(
    log.err,
    "error: Manifest is outdated\ncode: manifest_outdated\nhelp: loopfile upgrade - < old.yaml > new.yaml\n",
  );
  assert.deepEqual(log.asked, []);
  assert.equal(log.out, "");
});

test("check with a terminal and an empty answer shows the diff and rewrites", async () => {
  const src = await folder(V0);
  const { io, log } = makeIo(true, [""]);
  assert.deepEqual(await checkManifestVersion(src, io, UPGRADES), { ok: true });
  assert.deepEqual(log.asked, ["Manifest is outdated. Upgrade? [Y/n] "]);
  assert.match(log.out, /- oldSteps:\n\+ formatVersion: 1\n\+ steps:\n/);
  assert.match(log.out, /Upgraded .* from formatVersion 0 to 1\.\n$/);
  assert.ok(isLoaded(await loadDirectory(src)));
});

test("check answered no, or at end of input, changes nothing and exits 1", async () => {
  for (const answer of ["n", null]) {
    const src = await folder(V0);
    const { io, log } = makeIo(true, [answer]);
    assert.deepEqual(await checkManifestVersion(src, io, UPGRADES), { ok: false, exitCode: 1 });
    assert.equal(log.err, "Upgrade declined. Nothing changed.\n");
    assert.equal(await readFile(join(src, "manifest.yaml"), "utf8"), V0);
  }
});

test("check asks again after an unclear answer", async () => {
  const src = await folder(V0);
  const { io, log } = makeIo(true, ["maybe", "y"]);
  assert.deepEqual(await checkManifestVersion(src, io, UPGRADES), { ok: true });
  assert.equal(log.asked.length, 2);
  assert.ok(isLoaded(await loadDirectory(src)));
});

test("check passes a current or newer manifest on to the loader", async () => {
  for (const text of [V1, V2]) {
    const src = await folder(text);
    const { io, log } = makeIo(true);
    assert.deepEqual(await checkManifestVersion(src, io, UPGRADES), { ok: true });
    assert.deepEqual(log.asked, []);
    assert.equal(log.out + log.err, "");
  }
});

test("check reports an invalid upgrade result", async () => {
  const bad = makeIo(true, ["y"]);
  assert.deepEqual(await checkManifestVersion(await folder(BAD_V0), bad.io, UPGRADES), {
    ok: false,
    exitCode: 1,
  });
  assert.deepEqual(bad.log.asked, []);
});

test("check and upgrade give byte-identical results on two copies", async () => {
  for (const make of [folder, thin, packed]) {
    const a = await make(V0);
    const b = await make(V0);
    await checkManifestVersion(a, makeIo(true, ["y"]).io, UPGRADES);
    await upgradeCommand(["upgrade", b], makeIo(false).io, UPGRADES);
    if (make === folder) {
      assert.deepEqual(
        await readFile(join(a, "manifest.yaml")),
        await readFile(join(b, "manifest.yaml")),
      );
    } else {
      assert.deepEqual(await readFile(a), await readFile(b));
    }
  }
});
