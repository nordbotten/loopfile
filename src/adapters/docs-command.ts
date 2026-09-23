import { readFile } from "node:fs/promises";
import { renderOperatorFailure } from "../application/operator-error.ts";

type Out = (text: string | Uint8Array) => void;
type Err = (text: string) => void;

const TOPICS = {
  format: { summary: "The Loopfile format", file: "../../docs/loopfile-format.md" },
  manifest: { summary: "The v1 manifest", file: "../../docs/manifest-v1.md" },
  runtime: { summary: "How a run works", file: "../../docs/runtime.md" },
  patterns: { summary: "Loop patterns", file: "../../docs/loop-patterns.md" },
  skill: { summary: "The Loopfile agent skill", file: "../../skills/loopfile/SKILL.md" },
} as const;

const TOPIC_NAMES = Object.keys(TOPICS).join(", ");
const USAGE = `Valid topics: ${TOPIC_NAMES}`;
const HELP = `Usage: loopfile docs [<topic>]

Print shipped Loopfile documentation, or list the available topics.
Topics: ${TOPIC_NAMES}
`;

/** Lists or prints the markdown shipped with the npm package. */
export async function docsCommand(argv: readonly string[], out: Out, err: Err): Promise<number> {
  if (argv.includes("--help")) {
    out(HELP);
    return 0;
  }
  const topic = argv[1];
  if (argv.length > 2) {
    return fail(err, `docs takes zero or one topic`, "bad_argument");
  }
  if (topic === undefined) {
    out(
      `${Object.entries(TOPICS)
        .map(([name, { summary }]) => `${name}: ${summary}`)
        .join("\n")}\n`,
    );
    return 0;
  }

  const document = TOPICS[topic as keyof typeof TOPICS];
  if (document === undefined) {
    return fail(err, `unknown docs topic '${topic}'`, "bad_argument");
  }

  try {
    out(await readFile(new URL(document.file, import.meta.url)));
    return 0;
  } catch (error) {
    return fail(
      err,
      `could not read docs topic '${topic}': ${error instanceof Error ? error.message : String(error)}`,
      "operation_failed",
    );
  }
}

function fail(err: Err, summary: string, code: "bad_argument" | "operation_failed"): 2 {
  err(renderOperatorFailure({ summary, code, help: USAGE }).stderr);
  return 2;
}
