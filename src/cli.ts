#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  type AttemptEnv,
  dataAppend,
  dataGet,
  dataPut,
  reportResult,
} from "./adapters/attempt-client.ts";
import { cancelCommand } from "./adapters/cancel-command.ts";
import { checkCommand } from "./adapters/check-command.ts";
import { docsCommand } from "./adapters/docs-command.ts";
import { readStdin as readRealStdin } from "./adapters/input.ts";
import { interruptCommand } from "./adapters/interrupt-command.ts";
import { launchCommand } from "./adapters/launch-command.ts";
import { listCommand } from "./adapters/list-command.ts";
import { logsCommand } from "./adapters/logs-command.ts";
import { loopCommand } from "./adapters/loop-command.ts";
import { loopOwnerCommand } from "./adapters/loop-owner.ts";
import { ownerCommand } from "./adapters/owner-command.ts";
import { packCommand } from "./adapters/pack-command.ts";
import { pruneCommand } from "./adapters/prune-command.ts";
import { removeCommand } from "./adapters/remove-command.ts";
import { resultCommand as operatorResultCommand } from "./adapters/result-command.ts";
import { resumeCommand } from "./adapters/resume-command.ts";
import { statusCommand } from "./adapters/status-command.ts";
import { tailCommand } from "./adapters/tail-command.ts";
import { unpackCommand } from "./adapters/unpack-command.ts";
import { terminalUpgradeIo, upgradeCommand } from "./adapters/upgrade-command.ts";
import { parseDataGetKey } from "./application/data-get.ts";
import { parseDataAppendArgs, parseDataPutArgs } from "./application/data-put.ts";
import { MESSAGE_LIMIT_BYTES, parseResultArgs, STEP_RESULT_HELP } from "./application/result.ts";
import {
  renderStep,
  requireEndpoint,
  routeStepCommand,
  type StepReport,
  stepCommandHelp,
} from "./application/step-commands.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `loopfile ${version} - run deterministic agent workflows

Usage:
  loopfile <directory|file.loop|github:owner/repo|-> [-d] [--trust] [--input <name>=<value>]...
  loopfile [options]

Learn more:
  loopfile docs manifest

Commands:
  pack <directory> [-o <path>] [--force]
  loop <source> (--times N | --list <file> | --next <command>) [--input k=v]... [--retry N] [--max-runs N] [--pause <duration>] [-d]
  check <source> [--json]
  docs [<topic>]
  list [--json]
  cancel <runid|loopid> [--now|--after-run]
  interrupt <runid>
  resume [<runid>] [-d] [--kill-leftovers]
  remove <runid> [--kill-leftovers] [--force]
  prune [--older-than <age>] [--dry-run]
  logs <runid> [<attempt>] [--stdout | --stderr] [--iteration <n>]
  logs <runid> --owner
  status [<runid>|<loopid>] [--monitor | --json]
  tail <runid|loopid> [--json]
  result <runid> [--json]
  unpack <file.loop> [<destination>]
  upgrade <source>

Options:
  -d, --detach
  --trust
  --input <name>=<value>
  -h, --help
  -v, --version
`;

/**
 * Runs the CLI. Returns the process exit code.
 *
 * `out` is stdout and `err` is stderr. A step command keeps them apart: its
 * report goes to `err`, so `loopfile data get spec.md > spec.md` needs no flag
 * (#83). Confirmation commands also keep their AXI report on `err`.
 *
 * `loopfile <source>` returns a promise: it checks the Loopfile, starts a run
 * owner and waits for its "ready" (#35).
 *
 * `__owner`, `cancel`, `check`, `data get`, `interrupt`, `list`, `logs`, `status` and `tail`
 * are the commands that return a promise: `__owner` because a run owner lives as long
 * as its run (ADR 0008), `cancel` because it asks the run owner over its
 * control socket and waits for it to stop (#63), `data get` because it calls one over `LOOPFILE_ENDPOINT` (ADR
 * 0005), `list` because it scans every run folder and pings each live one's
 * socket (#52), `logs` because it reads an attempt folder from disk (#37),
 * `tail` because it reads and follows a run folder until the run ends or its
 * owner is gone (#51). Every other command answers at once.
 */
export function main(
  argv: string[],
  out: (text: string | Uint8Array) => void,
  err: (text: string) => void,
  env: Record<string, string | undefined> = process.env,
  readStdin: () => Promise<Buffer> = readRealStdin,
): number | Promise<number> {
  // `data get`, `data put` and `data append` are dispatched here, ahead of
  // `routeStepCommand`, because they are the step commands that are actually
  // built: they need the real run owner call, not the "not built yet"
  // placeholder every other step command still gets. Everything else about
  // being a step command — the endpoint gate, the stderr-only report — still
  // comes from the same shared code (#83).
  if (argv[0] === "data" && argv[1] === "get") return dataGetCommand(argv, out, err, env);
  if (argv[0] === "data" && argv[1] === "put") return dataPutCommand(argv, err, env, readStdin);
  if (argv[0] === "data" && argv[1] === "append") return dataAppendCommand(argv, err, env);
  if (argv[0] === "result") {
    return env.LOOPFILE_ENDPOINT === undefined || env.LOOPFILE_ENDPOINT === ""
      ? operatorResultCommand(argv, out, err, env)
      : stepResultCommand(argv, err, env);
  }

  // Dispatched by name, ahead of anything `loopfile <source>` will later do
  // with a positional (#35): `docs` and `logs` are command names reserved to
  // win over a source path, so `./check`, `./docs` and `./logs` only ever run
  // as paths (#37, decided in #91).
  if (argv[0] === "cancel") return cancelCommand(argv, out, err, env);
  if (argv[0] === "interrupt") return interruptCommand(argv, out, err, env);
  if (argv[0] === "check") return checkCommand(argv, out, err, readStdin);
  if (argv[0] === "docs") return docsCommand(argv, out, err);
  if (argv[0] === "list") return listCommand(argv, out, err, env);
  if (argv[0] === "loop") {
    return loopCommand(
      argv,
      import.meta.filename,
      { out, err, upgrade: terminalUpgradeIo(out, err) },
      env,
      {
        readStdin,
      },
    );
  }
  if (argv[0] === "logs") return logsCommand(argv, out, err, env);
  if (argv[0] === "remove") return removeCommand(argv, out, err, env);
  if (argv[0] === "prune") return pruneCommand(argv, out, err, env);
  if (argv[0] === "pack") return packCommand(argv, out, err);
  if (argv[0] === "resume") {
    return resumeCommand(
      argv,
      import.meta.filename,
      { out, err, monitor: { input: process.stdin, output: process.stdout } },
      env,
    );
  }
  if (argv[0] === "status") return statusCommand(argv, out, err, env);
  if (argv[0] === "tail") return tailCommand(argv, out, err, env);
  if (argv[0] === "unpack") return unpackCommand(argv, out, err);
  if (argv[0] === "upgrade")
    return upgradeCommand(argv, terminalUpgradeIo(out, err), undefined, readStdin);

  // Before `parseArgs`, because a step command has its own arguments and its
  // own flags: `result approved --message "..."` is not for this table. A
  // recognised step command never reaches the operator path below, so nothing
  // it does can put operator text on a step's stdout.
  const step = routeStepCommand(argv, env.LOOPFILE_ENDPOINT);
  if (step) {
    err(step.stderr);
    return step.exitCode;
  }

  let values: {
    help?: boolean;
    version?: boolean;
    detach?: boolean;
    trust?: boolean;
    input?: string[];
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        // Read again by `launchCommand`, which owns them; named here so the
        // strict parse accepts them.
        detach: { type: "boolean", short: "d" },
        trust: { type: "boolean" },
        input: { type: "string", multiple: true },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    out(`loopfile: ${(error as Error).message}\n${HELP}`);
    return 2;
  }

  // Hidden on purpose: `loopfile __owner <runid>` is how the CLI starts a run
  // owner (ADR 0008), not something a person types, so it is not in the help.
  if (positionals[0] === "__owner") return ownerCommand(positionals.slice(1), err, env);
  if (positionals[0] === "__loop-owner") {
    return loopOwnerCommand(positionals.slice(1), import.meta.filename, err, env);
  }

  if (values.version) {
    out(`${version}\n`);
    return 0;
  }
  if (values.help && positionals.length > 0) {
    return launchCommand(
      argv,
      import.meta.filename,
      {
        out,
        err,
        upgrade: terminalUpgradeIo(out, err),
        monitor: { input: process.stdin, output: process.stdout },
      },
      env,
      { readStdin },
    );
  }
  if (values.help || (positionals.length === 0 && !values.detach && !values.input)) {
    out(`${HELP}${stepCommandHelp(env.LOOPFILE_ENDPOINT)}`);
    return 0;
  }
  return launchCommand(
    argv,
    import.meta.filename,
    {
      out,
      err,
      upgrade: terminalUpgradeIo(out, err),
      monitor: { input: process.stdin, output: process.stdout },
    },
    env,
    { readStdin },
  );
}

/**
 * `data get <key>`'s own dispatch: the endpoint and argument checks every
 * step command shares stay synchronous, so only a call that actually reaches
 * the run owner returns a promise (#19).
 */
function dataGetCommand(
  argv: readonly string[],
  out: (text: string | Uint8Array) => void,
  err: (text: string) => void,
  env: Record<string, string | undefined>,
): number | Promise<number> {
  const blocked = requireEndpoint("data get", env.LOOPFILE_ENDPOINT);
  if (blocked) return finishStep(renderStep(blocked), err);

  const keyOrFailure = parseDataGetKey(argv);
  if (typeof keyOrFailure !== "string") return finishStep(renderStep(keyOrFailure), err);

  return dataGet(attemptEnvOf(env), keyOrFailure).then(({ report, content }) => {
    if (content) out(content);
    return finishStep(renderStep(report), err);
  });
}

/**
 * `data put <key> <file|->`'s own dispatch (#20): reads the source file (or
 * stdin for `-`) before the call, so the run owner never touches a path and
 * the bytes it stores are a copy taken at call time, not a live file handle.
 */
function dataPutCommand(
  argv: readonly string[],
  err: (text: string) => void,
  env: Record<string, string | undefined>,
  readStdin: () => Promise<Buffer>,
): number | Promise<number> {
  const blocked = requireEndpoint("data put", env.LOOPFILE_ENDPOINT);
  if (blocked) return finishStep(renderStep(blocked), err);

  const parsed = parseDataPutArgs(argv);
  if ("ok" in parsed) return finishStep(renderStep(parsed), err);

  return readPutSource(parsed.file, readStdin)
    .then((content): Promise<StepReport> | StepReport =>
      dataPut(attemptEnvOf(env), parsed.key, content),
    )
    .catch((error: Error) => readFailure("put", parsed.file, error))
    .then((report) => finishStep(renderStep(report), err));
}

/** `data append <key> <value>`'s own dispatch (#20): the value is a CLI argument, never a file. */
function dataAppendCommand(
  argv: readonly string[],
  err: (text: string) => void,
  env: Record<string, string | undefined>,
): number | Promise<number> {
  const blocked = requireEndpoint("data append", env.LOOPFILE_ENDPOINT);
  if (blocked) return finishStep(renderStep(blocked), err);

  const parsed = parseDataAppendArgs(argv);
  if ("ok" in parsed) return finishStep(renderStep(parsed), err);

  return dataAppend(attemptEnvOf(env), parsed.key, parsed.value).then((report) =>
    finishStep(renderStep(report), err),
  );
}

/** Reads `file`'s bytes, or all of stdin when `file` is `-`. */
function readPutSource(file: string, readStdin: () => Promise<Buffer>): Promise<Buffer> {
  return file === "-" ? readStdin() : readFile(file);
}

/** Turns a failed file/stdin read into the same kind of report a bad argument gets. */
function readFailure(verb: string, file: string, error: Error): StepReport {
  return {
    ok: false,
    summary: `\`data ${verb}\` could not read ${file === "-" ? "stdin" : file}: ${error.message}`,
    code: "missing_arg",
    help: [
      file === "-" ? "Reading stdin failed" : `Check the file exists and is readable: ${file}`,
      `Usage: loopfile data ${verb} <key> <file|->`,
    ],
  };
}

/** The attempt identity a step command sends with every call (ADR 0005). */
function attemptEnvOf(env: Record<string, string | undefined>): AttemptEnv {
  return {
    endpoint: env.LOOPFILE_ENDPOINT as string,
    attemptId: env.LOOPFILE_ATTEMPT_ID ?? "",
    secret: env.LOOPFILE_ATTEMPT_SECRET ?? "",
    iteration: iterationOf(env.LOOPFILE_ITERATION),
  };
}

/**
 * `result <outcome> [--message <text>]`'s own dispatch (#26): the endpoint
 * and argument checks every step command shares stay synchronous, so only a
 * call that actually reaches the run owner returns a promise. A truncated
 * `--message` gets its own stderr warning ahead of the report (#85).
 */
function stepResultCommand(
  argv: readonly string[],
  err: (text: string) => void,
  env: Record<string, string | undefined>,
): number | Promise<number> {
  if (argv.includes("--help")) {
    err(STEP_RESULT_HELP);
    return 0;
  }

  const blocked = requireEndpoint("result", env.LOOPFILE_ENDPOINT);
  if (blocked) return finishStep(renderStep(blocked), err);

  const argsOrFailure = parseResultArgs(argv);
  if (!argsOrFailure.ok) return finishStep(renderStep(argsOrFailure), err);

  if (argsOrFailure.truncated) {
    err(`warning: --message was cut to fit ${MESSAGE_LIMIT_BYTES} bytes\n`);
  }

  return reportResult(attemptEnvOf(env), argsOrFailure.outcome, argsOrFailure.message).then(
    (report) => finishStep(renderStep(report), err),
  );
}

/**
 * `LOOPFILE_ITERATION` as a whole number, or nothing when it is unset or not
 * one. A malformed value is treated the same as a missing one rather than
 * sent on as `NaN`, which `JSON.stringify` turns into `null` and the run
 * owner would then have to make sense of.
 */
function iterationOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function finishStep(
  rendered: { stderr: string; exitCode: number },
  err: (text: string) => void,
): number {
  err(rendered.stderr);
  return rendered.exitCode;
}

// `argv[1]` is the path the user ran, which for an installed CLI is npm's
// symlink in its `bin` folder. `import.meta.filename` is always the real file,
// so compare against the resolved path, or nothing runs.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  process.exitCode = await main(
    process.argv.slice(2),
    (text) => process.stdout.write(text),
    (text) => process.stderr.write(text),
  );
}
