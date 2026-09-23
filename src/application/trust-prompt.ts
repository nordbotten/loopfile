import type { Step, Workflow } from "../domain/model.ts";

export interface TrustPromptRemote {
  readonly host: string;
  readonly repo: string;
  readonly path?: string;
  readonly ref?: string;
  readonly sha: string;
}

/** Renders the decision header for an untrusted remote workflow. */
export function renderTrustPrompt(
  workflow: Workflow,
  remote: TrustPromptRemote,
  source: string,
  color: boolean,
): string {
  const lines = [
    danger(
      " DANGER  This Loopfile can run any shell command and any agent in your workspace, as you. ",
      color,
    ),
    danger(
      " Trust it only if you trust the people who can push to it.                              ",
      color,
    ),
    "",
    `${colorize("?", color, "33")} Trust this Remote Loopfile?`,
    "",
    `  Source   ${source}`,
    `  Commit   ${remote.sha}  (${remote.ref ?? "default branch"})`,
    `  Steps    ${workflow.steps.length}`,
    ...stepLines(workflow.steps, color),
    "",
    `  Full text: ${colorize(`loopfile unpack ${unpackSource(remote, source)} ./look`, color, "2")}`,
  ];
  return lines.join("\n");
}

function colorize(text: string, color: boolean, code: string): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function danger(text: string, color: boolean): string {
  return colorize(color ? text : text.trim(), color, "1;91;40");
}

function unpackSource(remote: TrustPromptRemote, source: string): string {
  const gitSource = /^git\+/i.test(source);
  const canonical = gitSource
    ? `${source.slice(0, source.indexOf("://")).toLowerCase()}://${remote.host}/${remote.repo}`
    : `github:${remote.repo}${remote.path === undefined ? "" : `/${remote.path}`}`;
  return gitSource
    ? `${canonical}@${remote.sha.slice(0, 7)}${remote.path === undefined ? "" : `#subdirectory=${remote.path}`}`
    : `${canonical}@${remote.sha.slice(0, 7)}`;
}

function stepLines(steps: Workflow["steps"], color: boolean): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    lines.push(`    ${step.id.padEnd(10)} ${step.kind.padEnd(8)} ${stepDescription(step, color)}`);
    if ("args" in step && step.args.length > 0) {
      lines.push(
        `    ${"".padEnd(10)} ${"".padEnd(8)} ${colorize("args:", color, "33")} ${step.args.join(" ")}`,
      );
    }
  }
  return lines;
}

function stepDescription(step: Step, color: boolean): string {
  if (step.kind === "command") {
    const lines = step.run.split(/\r?\n/);
    return `runs: ${lines[0]}${lines.length > 1 ? colorize(" …", color, "2") : ""}`;
  }
  return "harness" in step ? `${step.harness} ${step.model ?? "-"}` : "-";
}
