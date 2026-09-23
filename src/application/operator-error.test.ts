import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type OperatorErrorCode,
  renderLaunchConfirmation,
  renderOperatorConfirmation,
  renderOperatorFailure,
  renderOperatorFailureLines,
} from "./operator-error.ts";

test("operator failures render an AXI block and exit 2", () => {
  const codes: readonly OperatorErrorCode[] = [
    "no_such_run",
    "no_such_loop",
    "log_unreadable",
    "log_corrupt",
    "bad_argument",
    "no_terminal",
    "owner_gone",
    "owner_alive",
    "workspace_dirty",
    "leftover_processes",
    "already_ended",
    "workspace_missing",
    "invalid_manifest",
    "manifest_outdated",
    "format_mismatch",
    "untrusted",
    "operation_failed",
  ];
  for (const code of codes) {
    assert.deepEqual(
      renderOperatorFailure({ summary: "could not read run", code, help: "Try again" }),
      {
        stderr: `error: could not read run\ncode: ${code}\nhelp: Try again\n`,
        exitCode: 2,
      },
    );
  }
});

test("operator failures render one error line per problem", () => {
  assert.deepEqual(
    renderOperatorFailureLines(
      ["line 2: name: bad", "line 3: steps: missing"],
      "invalid_manifest",
      "Fix it",
      1,
    ),
    {
      stderr:
        "error: line 2: name: bad\nerror: line 3: steps: missing\ncode: invalid_manifest\nhelp: Fix it\n",
      exitCode: 1,
    },
  );
});

test("operator failure values escape and quote non-plain values", () => {
  assert.deepEqual(
    renderOperatorFailureLines(["  path  ", 'path\\name"'], "invalid_manifest", " Fix it ", 1),
    {
      stderr:
        'error: "  path  "\nerror: "path\\\\name\\""\ncode: invalid_manifest\nhelp: " Fix it "\n',
      exitCode: 1,
    },
  );
});

test("launch confirmation shows a branch only when the workspace has one", () => {
  assert.equal(
    renderLaunchConfirmation("run-1", "isolate", "/runs/run-1/workspace", "loopfile/run-1"),
    "started: run-1\nworkspace: isolate · /runs/run-1/workspace\nbranch: loopfile/run-1\n",
  );
  assert.equal(
    renderLaunchConfirmation("run-2", "isolate", "/runs/run-2/workspace", undefined),
    "started: run-2\nworkspace: isolate · /runs/run-2/workspace\n",
  );
});

test("operator confirmations render ordered AXI facts", () => {
  assert.equal(
    renderOperatorConfirmation({ packed: "/tmp/feature.loop", note: "a\nb" }),
    'packed: /tmp/feature.loop\nnote: "a\\nb"\n',
  );
});

test("operator work failures can exit 1", () => {
  assert.deepEqual(
    renderOperatorFailure(
      { summary: "manifest is invalid", code: "invalid_manifest", help: "Fix it" },
      1,
    ),
    { stderr: "error: manifest is invalid\ncode: invalid_manifest\nhelp: Fix it\n", exitCode: 1 },
  );
});
