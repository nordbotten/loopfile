import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { chooseOnTerminal } from "./trust-prompt.ts";

const OPTIONS = ["Trust repo host/org/repo", "Trust everything from host/org", "Deny"];

test("terminal trust picker uses arrows and Enter, starting on Deny", async () => {
  const raw: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    setRawMode(value: boolean) {
      raw.push(value);
    },
  });
  let output = "";
  const choice = chooseOnTerminal("? Trust this Remote Loopfile?", OPTIONS, 2, input, (text) => {
    output += text;
  });

  input.emit("keypress", "", { name: "up" });
  input.emit("keypress", "", { name: "up" });
  input.emit("keypress", "", { name: "return" });

  assert.equal(await choice, 0);
  assert.deepEqual(raw, [true, false]);
  assert.match(output, /\? Trust this Remote Loopfile\?/);
  assert.match(output, /> Trust repo host\/org\/repo/);
});

test("Ctrl-C and EOF cancel the terminal trust picker", async () => {
  for (const cancel of [
    (input: PassThrough) => input.emit("keypress", "\u0003", { name: "c", ctrl: true }),
    (input: PassThrough) => input.emit("end"),
  ]) {
    const raw: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
      setRawMode(value: boolean) {
        raw.push(value);
      },
    });
    const choice = chooseOnTerminal("Trust?", OPTIONS, 2, input, () => undefined);
    cancel(input);
    assert.equal(await choice, null);
    assert.deepEqual(raw, [true, false]);
  }
});
