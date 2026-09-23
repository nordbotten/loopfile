import { emitKeypressEvents, type Key } from "node:readline";
import type { Readable } from "node:stream";

export interface TrustIo {
  /** `process.stdin.isTTY && process.stderr.isTTY`. */
  readonly isTTY: boolean;
  readonly err: (text: string) => void;
  readonly choose: (
    header: string,
    options: readonly string[],
    defaultIndex: number,
  ) => Promise<number | null>;
}

/** The `TrustIo` of the real terminal. */
export function terminalTrustIo(err: (text: string) => void): TrustIo {
  return {
    isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
    err,
    choose: (header, options, defaultIndex) =>
      chooseOnTerminal(header, options, defaultIndex, process.stdin, err),
  };
}

/** Reads an arrow-key choice; Ctrl-C and EOF return `null`. */
export function chooseOnTerminal(
  header: string,
  options: readonly string[],
  defaultIndex: number,
  input: Readable & { setRawMode?(raw: boolean): unknown },
  err: (text: string) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    let selected = defaultIndex;
    let drawn = false;
    let finished = false;

    const draw = (): void => {
      if (drawn) err(`\x1b[${options.length}A\x1b[J`);
      else err(`${header}\n`);
      err(
        `${options.map((option, index) => `${index === selected ? ">" : " "} ${option}`).join("\n")}\n`,
      );
      drawn = true;
    };

    const finish = (choice: number | null): void => {
      if (finished) return;
      finished = true;
      input.setRawMode?.(false);
      input.off("keypress", onKeypress);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.pause();
      err("\n");
      resolve(choice);
    };

    const onKeypress = (_text: string | undefined, key: Key | undefined): void => {
      if (key === undefined) return;
      if ((key.ctrl === true && key.name === "c") || key.name === "escape") {
        finish(null);
      } else if (key.name === "up") {
        selected = Math.max(0, selected - 1);
        draw();
      } else if (key.name === "down") {
        selected = Math.min(options.length - 1, selected + 1);
        draw();
      } else if (key.name === "return" || key.name === "enter") {
        finish(selected);
      }
    };
    const onEnd = (): void => finish(null);

    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", onKeypress);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.resume();
    draw();
  });
}
