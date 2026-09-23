import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource } from "./source.ts";

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
