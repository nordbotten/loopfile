import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource } from "./source.ts";

test("parseSource recognizes only the first GitHub remote form", () => {
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
    ["github:acme/loops/path", { kind: "local", source: "github:acme/loops/path" }],
    ["github:acme/loops@main", { kind: "local", source: "github:acme/loops@main" }],
    ["./source", { kind: "local", source: "./source" }],
    ["github:acme", { kind: "local", source: "github:acme" }],
  ] as const;

  for (const [text, expected] of cases) assert.deepEqual(parseSource(text), expected, text);
});
