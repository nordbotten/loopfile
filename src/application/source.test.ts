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
