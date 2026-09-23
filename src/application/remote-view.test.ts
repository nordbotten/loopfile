import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteRecord } from "../domain/events.ts";
import { formatRemoteLine } from "./remote-view.ts";

const SHA = "4c9d077abcde1234567890abcdef1234567890ab";

const remote: RemoteRecord = {
  host: "github.com",
  repo: "acme/loops",
  path: "review",
  ref: "main",
  sha: SHA,
};

test("formats a remote line with path, ref and a short SHA by default", () => {
  assert.equal(formatRemoteLine(remote), "remote: github.com/acme/loops/review @ main (4c9d077)");
});

test("formats a remote line without optional path or ref and can keep the full SHA", () => {
  assert.equal(
    formatRemoteLine({ host: "github.com", repo: "acme/loops", sha: SHA }, true),
    `remote: github.com/acme/loops (${SHA})`,
  );
});
