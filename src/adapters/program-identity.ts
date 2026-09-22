/** The package version and CLI entry digest that identify a running program. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

export interface ProgramIdentity {
  readonly version: string;
  readonly digest: string;
}

export async function programIdentity(cli: string): Promise<ProgramIdentity> {
  return {
    version,
    digest: createHash("sha256")
      .update(await readFile(cli))
      .digest("hex"),
  };
}
