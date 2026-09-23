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

  for (const [text, expected] of cases) assert.deepEqual(parseSource(text), expected, text);
});

test("parseSource refuses dot, dot-dot and empty path segments", () => {
  for (const text of [
    "github:acme/loops/.",
    "github:acme/loops/..",
    "github:acme/loops/a/../b",
    "github:acme/loops/a//b",
  ]) {
    assert.throws(() => parseSource(text), /path segment/);
  }
});
