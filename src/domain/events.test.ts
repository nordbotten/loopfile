import assert from "node:assert/strict";
import { test } from "node:test";
import { isRemoteRecord } from "./events.ts";

const remote = {
  host: "github.com",
  repo: "acme/group/loops",
  path: "packages/loop",
  ref: "feature/ref",
  sha: "a".repeat(40),
};

test("accepts normalized remote records with optional fields omitted", () => {
  assert.equal(isRemoteRecord(remote), true);
  assert.equal(
    isRemoteRecord({ host: "git.example.test", repo: "acme/loops", sha: remote.sha }),
    true,
  );
});

test("rejects malformed remote records", () => {
  const invalid: readonly unknown[] = [
    null,
    undefined,
    [],
    "remote",
    1,
    { ...remote, extra: true },
    { ...remote, host: "" },
    { ...remote, host: "GitHub.com" },
    { ...remote, host: "user@github.com" },
    { ...remote, repo: "Acme/loops" },
    { ...remote, repo: "loops" },
    { ...remote, repo: "acme//loops" },
    { ...remote, repo: "acme/../loops" },
    { ...remote, path: null },
    { ...remote, path: "" },
    { ...remote, path: "/packages" },
    { ...remote, path: "packages/" },
    { ...remote, path: "packages//loop" },
    { ...remote, path: "packages/./loop" },
    { ...remote, path: "packages/../loop" },
    { ...remote, ref: "" },
    { ...remote, ref: 1 },
    { ...remote, sha: null },
    { ...remote, sha: "a".repeat(39) },
    { ...remote, sha: "g".repeat(40) },
    { ...remote, sha: "A".repeat(40) },
  ];

  for (const value of invalid) assert.equal(isRemoteRecord(value), false, JSON.stringify(value));
});
