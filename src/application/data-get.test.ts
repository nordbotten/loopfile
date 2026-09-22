import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDataGetKey, readDataGetReply } from "./data-get.ts";

test("the key is the third argument", () => {
  assert.equal(parseDataGetKey(["data", "get", "spec.md"]), "spec.md");
});

test("a missing key is a fixable missing_arg failure", () => {
  const failure = parseDataGetKey(["data", "get"]);
  assert.notEqual(typeof failure, "string");
  assert.deepEqual(failure, {
    ok: false,
    summary: "`data get` needs a key",
    code: "missing_arg",
    help: [
      "Usage: loopfile data get <key>",
      "The key names an earlier step's put, or a launch input as input.<name>",
    ],
  });
});

test("an empty key is treated the same as a missing one", () => {
  const failure = parseDataGetKey(["data", "get", ""]);
  assert.notEqual(typeof failure, "string");
});

test("a successful reply decodes its base64 content and reports the putting attempt", () => {
  const { report, content } = readDataGetReply(
    {
      ok: true,
      attemptId: "004-review",
      size: 5,
      content: Buffer.from("hello").toString("base64"),
    },
    "review.feedback",
  );
  assert.deepEqual(report, {
    ok: true,
    summary: "read review.feedback",
    fields: { attempt: "004-review", bytes: "5" },
  });
  assert.equal(content?.toString(), "hello");
});

test("a launch input has no putting attempt to name", () => {
  const { report } = readDataGetReply(
    { ok: true, size: 4, content: Buffer.from("task").toString("base64") },
    "input.task",
  );
  assert.ok(report.ok);
  assert.ok(report.ok && !("attempt" in (report.fields ?? {})));
});

test("binary content round-trips through the base64 wire byte for byte", () => {
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 10, 13]);
  const { content } = readDataGetReply(
    { ok: true, size: bytes.byteLength, content: Buffer.from(bytes).toString("base64") },
    "implement.blob",
  );
  assert.deepEqual(new Uint8Array(content ?? []), bytes);
});

test("an unknown_key refusal names the key that has no value", () => {
  const { report, content } = readDataGetReply(
    { ok: false, code: "unknown_key", message: "no value for key: spec.ful" },
    "spec.ful",
  );
  assert.equal(content, undefined);
  assert.deepEqual(report, {
    ok: false,
    summary: 'no data key "spec.ful"',
    code: "unknown_key",
    help: [
      "Keys are set by earlier steps; check the step that puts it",
      "Run `loopfile data get <key>` with a key from your prompt",
    ],
  });
});

test("a stale attempt refusal is unfixable and carries the run owner's message", () => {
  const { report } = readDataGetReply(
    { ok: false, code: "stale_attempt", message: "not the attempt running now (007-fix)" },
    "review.feedback",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
  assert.match(report.summary, /not the attempt running now/);
});

test("a reply with no recognisable shape reads as an unfixable refusal, not a crash", () => {
  for (const reply of [undefined, null, "not an object", 7, [], {}]) {
    const { report, content } = readDataGetReply(reply, "spec.md");
    assert.equal(content, undefined);
    assert.ok(!report.ok);
    assert.equal(report.code, "stale_attempt");
  }
});

test("a connection failure with no reply object still reports a message", () => {
  const { report } = readDataGetReply({ ok: false, message: "connect ECONNREFUSED" }, "spec.md");
  assert.ok(!report.ok);
  assert.match(report.summary, /ECONNREFUSED/);
});

test("a reply claiming success with no usable content is not trusted as one", () => {
  const { report } = readDataGetReply({ ok: true }, "spec.md");
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});
