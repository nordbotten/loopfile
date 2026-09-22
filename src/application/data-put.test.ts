import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDataAppendArgs, parseDataPutArgs, readDataPutReply } from "./data-put.ts";

test("parseDataPutArgs reads the key and the file", () => {
  assert.deepEqual(parseDataPutArgs(["data", "put", "review.feedback", "./review.md"]), {
    key: "review.feedback",
    file: "./review.md",
  });
});

test("parseDataPutArgs accepts - as the file, meaning stdin", () => {
  assert.deepEqual(parseDataPutArgs(["data", "put", "review.feedback", "-"]), {
    key: "review.feedback",
    file: "-",
  });
});

test("parseDataPutArgs is a fixable missing_arg failure with no key, no file, or either empty", () => {
  for (const argv of [
    ["data", "put"],
    ["data", "put", "review.feedback"],
    ["data", "put", "", "./review.md"],
    ["data", "put", "review.feedback", ""],
  ]) {
    const failure = parseDataPutArgs(argv);
    assert.ok("ok" in failure && !failure.ok);
    assert.equal(failure.code, "missing_arg");
  }
});

test("parseDataAppendArgs reads the key and the value", () => {
  assert.deepEqual(parseDataAppendArgs(["data", "append", "review.notes", "looks fine"]), {
    key: "review.notes",
    value: "looks fine",
  });
});

test("parseDataAppendArgs accepts an empty value, only a missing one is an error", () => {
  assert.deepEqual(parseDataAppendArgs(["data", "append", "review.notes", ""]), {
    key: "review.notes",
    value: "",
  });
  const failure = parseDataAppendArgs(["data", "append", "review.notes"]);
  assert.ok("ok" in failure && !failure.ok);
  assert.equal(failure.code, "missing_arg");
});

test("a successful put reply reports the byte size and digest", () => {
  const report = readDataPutReply(
    { ok: true, size: 10, digest: "abc123" },
    "review.feedback",
    "put",
  );
  assert.deepEqual(report, {
    ok: true,
    summary: "put review.feedback",
    fields: { bytes: "10", digest: "abc123" },
  });
});

test("a successful append reply summarises as append, not put", () => {
  const report = readDataPutReply({ ok: true, size: 4, digest: "abc" }, "review.notes", "append");
  assert.ok(report.ok);
  assert.equal(report.summary, "append review.notes");
});

test("an invalid_key refusal is fixable and carries the run owner's message", () => {
  const report = readDataPutReply(
    {
      ok: false,
      code: "invalid_key",
      message: "input.* is reserved for launch inputs: input.task",
    },
    "input.task",
    "put",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "invalid_key");
  assert.match(report.summary, /reserved for launch inputs/);
  assert.ok(report.help.length > 0);
});

test("a write_kind_mismatch refusal names the command already used", () => {
  const report = readDataPutReply(
    {
      ok: false,
      code: "write_kind_mismatch",
      message:
        "review.notes was first written with data append; use the same command for every write to this key",
    },
    "review.notes",
    "put",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "write_kind_mismatch");
  assert.match(report.summary, /data append/);
});

test("a stale_attempt refusal is unfixable", () => {
  const report = readDataPutReply(
    { ok: false, code: "stale_attempt", message: "not the attempt running now (007-fix)" },
    "review.feedback",
    "put",
  );
  assert.ok(!report.ok);
  assert.equal(report.code, "stale_attempt");
});

test("a reply with no recognisable shape reads as an unfixable refusal, not a crash", () => {
  for (const reply of [undefined, null, "not an object", 7, [], {}, { ok: true }]) {
    const report = readDataPutReply(reply, "review.feedback", "put");
    assert.ok(!report.ok);
    assert.equal(report.code, "stale_attempt");
  }
});
