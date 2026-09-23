import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource, SourceParseError } from "./source.ts";

test("parseSource reads repository paths and refs", () => {
  const cases = [
    [
      "github:Acme/Loops",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
      },
    ],
    [
      "github:Acme/Loops/a@b@feature/branch",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        path: "a@b",
        ref: "feature/branch",
      },
    ],
    [
      "github:acme/loops/folder/",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        path: "folder",
      },
    ],
    [
      "github:acme/loops@main",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        ref: "main",
      },
    ],
    ["./source", { kind: "local", source: "./source" }],
    ["github:acme", { kind: "local", source: "github:acme" }],
    ["github:acme/loops?query", { kind: "local", source: "github:acme/loops?query" }],
  ] as const;

  for (const [text, expected] of cases) assert.deepEqual(parseSource(text, false), expected, text);
});

test("pip Git sources keep the host and whole repository path without recording credentials", () => {
  const cases = [
    [
      "git+https://user:token@Git.Example.Test:8443/Grp/Sub/Loops.git@feature/review#subdirectory=review",
      "https://user:token@Git.Example.Test:8443/Grp/Sub/Loops.git",
    ],
    [
      "git+ssh://user:token@Git.Example.Test:8443/Grp/Sub/Loops.git@feature/review#subdirectory=review",
      "ssh://user:token@Git.Example.Test:8443/Grp/Sub/Loops.git",
    ],
  ] as const;

  const parsed = cases.map(([text, url]) => {
    const source = parseSource(text, false);
    assert.equal(parseSource(text, true).kind, "remote");
    assert.deepEqual(source, {
      kind: "remote",
      host: "git.example.test:8443",
      repo: "grp/sub/loops",
      url,
      path: "review",
      ref: "feature/review",
    });
    assert.doesNotMatch(
      JSON.stringify({ host: source.host, repo: source.repo, path: source.path, ref: source.ref }),
      /user|token/i,
    );
    return source;
  });
  assert.equal(parsed[0]?.host, parsed[1]?.host);
  assert.equal(parsed[0]?.repo, parsed[1]?.repo);
  assert.deepEqual(parseSource("git+ssh://Git.Example.Test:2222/Org/Repo", false), {
    kind: "remote",
    host: "git.example.test:2222",
    repo: "org/repo",
    url: "ssh://Git.Example.Test:2222/Org/Repo",
  });
  assert.deepEqual(parseSource("git+https://Git.Example.Test:443/Org/Repo", false), {
    kind: "remote",
    host: "git.example.test:443",
    repo: "org/repo",
    url: "https://Git.Example.Test:443/Org/Repo",
  });
});

test("malformed Git VCS URLs are rejected", () => {
  for (const text of [
    "git+https://[",
    "git+ftp://git.example.test/org/repo",
    "git+https://git.example.test",
    "git+https://git.example.test/org/repo?download=1",
    "git+https://git.example.test/repo",
    "git+https://git.example.test/org/repo@",
    "git+https://git.example.test/org/.git",
    "git+https://git.example.test/org/repo#branch=main",
    "git+https://git.example.test/org/repo#subdirectory=",
    "git+https://git.example.test/org/repo#subdirectory=a/../b",
  ]) {
    assert.throws(
      () => parseSource(text, false),
      (error: unknown) =>
        error instanceof SourceParseError &&
        error.help ===
          "Use git+https:// or git+ssh:// with <host>/<org>/<repo>[@ref][#subdirectory=path].",
      text,
    );
  }
});

test("refused Git source forms name the accepted form", () => {
  const cases = [
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
  ] as const;

  for (const [text, help] of cases) {
    for (const exists of [false, true]) {
      assert.throws(
        () => parseSource(text, exists),
        (error: unknown) => error instanceof SourceParseError && error.help === help,
        text,
      );
    }
  }
});

test("GitHub browser links strip queries and fragments and accept root suffixes", () => {
  const cases = [
    [
      "https://github.com/Acme/Loops?tab=readme",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
      },
    ],
    [
      "https://github.com/acme/loops/tree/main/sub#readme",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        browserLink: { kind: "tree", rest: "main/sub" },
      },
    ],
    [
      "https://github.com/acme/loops/blob/v1/a/x.loop",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        browserLink: { kind: "blob", rest: "v1/a/x.loop" },
      },
    ],
    [
      "https://github.com/acme/loops/tree/main/",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        browserLink: { kind: "tree", rest: "main" },
      },
    ],
    [
      "https://github.com/acme/loops.git/",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
      },
    ],
    [
      "https://github.com/acme/loops.git-extra",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops.git-extra",
        url: "https://github.com/acme/loops.git-extra",
      },
    ],
  ] as const;

  for (const [text, expected] of cases) assert.deepEqual(parseSource(text, true), expected, text);
});

test("GitHub browser links report unsupported routes and invalid path segments", () => {
  for (const [text, message] of [
    [
      "https://github.com/acme/loops/issues/1",
      "unsupported GitHub browser URL path in https://github.com/acme/loops/issues/1",
    ],
    [
      "https://github.com/acme/loops/tree",
      "unsupported GitHub browser URL path in https://github.com/acme/loops/tree",
    ],
    ["https://github.com/acme/loops/tree/main/a/../b", "invalid path segment in main/a/../b"],
    [
      "https://github.com/acme/loops/tree/main//b",
      "invalid GitHub browser link https://github.com/acme/loops/tree/main//b",
    ],
  ] as const) {
    assert.throws(() => parseSource(text, true), { message });
  }
});

test("GitHub browser links reject invalid repository names", () => {
  assert.throws(() => parseSource("https://github.com/", true), {
    message: "invalid GitHub browser link https://github.com/",
  });
  for (const path of [
    "!acme/loops",
    "acme!/loops",
    "acme/!loops",
    "acme/loops!",
    "acme/.",
    "acme/..",
    "/loops",
    "acme/",
  ]) {
    const url = `https://github.com/${path}`;
    assert.throws(() => parseSource(url, true), { message: `invalid GitHub browser link ${url}` });
  }
});

test("only a GitHub browser URL at the start of the source is remote", () => {
  for (const text of [
    "prefix https://github.com/acme/loops",
    "https://github.com.evil/acme/loops",
  ]) {
    assert.deepEqual(parseSource(text, true), { kind: "local", source: text });
  }
});

test("parseSource refuses dot, dot-dot and empty path segments", () => {
  for (const text of [
    "github:acme/loops/.",
    "github:acme/loops/..",
    "github:acme/loops/a/../b",
    "github:acme/loops/a//b",
  ]) {
    assert.throws(() => parseSource(text, false), /path segment/);
  }
});

test("bare GitHub sources match the shape only when no local path exists", () => {
  const owner = "a".repeat(39);
  const cases = [
    [
      "Acme/Loops/sub/path@feature/branch",
      {
        kind: "remote",
        host: "github.com",
        repo: "acme/loops",
        url: "https://github.com/acme/loops",
        path: "sub/path",
        ref: "feature/branch",
        bareSource: "Acme/Loops/sub/path@feature/branch",
      },
    ],
    [
      `${owner}/repo`,
      {
        kind: "remote",
        host: "github.com",
        repo: `${owner}/repo`,
        url: `https://github.com/${owner}/repo`,
        bareSource: `${owner}/repo`,
      },
    ],
    [
      "a/b@main",
      {
        kind: "remote",
        host: "github.com",
        repo: "a/b",
        url: "https://github.com/a/b",
        ref: "main",
        bareSource: "a/b@main",
      },
    ],
  ] as const;
  for (const [text, expected] of cases) assert.deepEqual(parseSource(text, false), expected, text);

  for (const text of [
    "word",
    "-owner/repo",
    `${"a".repeat(40)}/repo`,
    "a/.",
    "a/..",
    "a/repo/.",
    "a/repo/..",
    "a/repo/a//b",
    "a/repo/",
    "a/repo@",
    ".owner/repo",
    "/owner/repo",
    "~owner/repo",
  ]) {
    assert.deepEqual(parseSource(text, false), { kind: "local", source: text }, text);
  }
  assert.deepEqual(parseSource("acme/loops", true), {
    kind: "local",
    source: "acme/loops",
  });
});
