// PROTOTYPE — throwaway. Wayfinder ticket #7 "What the trust prompt shows".
// Prints three different trust prompts for one Remote Loopfile, so we can pick one.
// Run: node prototype/trust-prompt.mjs [A|B|C]   (no arg prints all three)
// Input is the real examples/implement-review manifest, posing as a fetched remote.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const src = "nordbotten/loopfile/examples/implement-review";
const key = "github.com/nordbotten/loopfile";
const owner = "github.com/nordbotten";
const ref = "main";
const sha = "faf1b41c2e9d07a1b6f3e8d54a2c19b07e6d3f12";
const manifestText = readFileSync("examples/implement-review/manifest.yaml", "utf8");
const m = parse(manifestText);

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
// Bold bright red on a fixed black background, so it looks the same on light and dark themes.
// With NO_COLOR set, the text alone is printed.
const danger = (s) => (process.env.NO_COLOR ? s.trim() : `\x1b[1;91;40m${s}\x1b[0m`);

function select(options) {
  // The default (Deny) is shown selected. Arrow keys move in the real thing.
  return options
    .map((o, i) => (i === options.length - 1 ? `${bold("❯")} ${bold(o)}` : `  ${o}`))
    .join("\n");
}

const trustOptions = [`Trust repo ${key}`, `Trust everything from ${owner}`, "Deny"];

// A: short, like mise and direnv. Name, SHA, a way to look, then the select.
function variantA() {
  return [
    `${yellow("?")} ${bold(src)} is not on your trust list.`,
    `  ${ref} @ ${sha.slice(0, 7)}. It runs shell commands and agents in your workspace.`,
    `  To read it first: ${dim(`loopfile unpack ${src}@${sha.slice(0, 7)} ./look`)}`,
    "",
    select(trustOptions),
  ].join("\n");
}

// B: a summary of what the Loopfile can do, from the manifest. No paging.
function variantB() {
  const lines = [
    danger(" DANGER  This Loopfile can run any shell command and any agent in your workspace, as you. "),
    danger(" Trust it only if you trust the people who can push to it.                              "),
    "",
    `${yellow("?")} Trust this Remote Loopfile?`,
    "",
    `  Source   ${src}`,
    `  Commit   ${sha}  (${ref})`,
    `  Steps    ${m.steps.length}`,
  ];
  for (const s of m.steps) {
    const what =
      s.kind === "command"
        ? `runs: ${s.run.trim().split("\n")[0]}${s.run.trim().includes("\n") ? dim(" …") : ""}`
        : `${s.harness}${s.model ? ` ${s.model}` : ""}`;
    lines.push(`    ${s.id.padEnd(10)} ${s.kind.padEnd(8)} ${what}`);
    if (s.args?.length) lines.push(`    ${"".padEnd(10)} ${"".padEnd(8)} ${yellow("args:")} ${s.args.join(" ")}`);
  }
  lines.push("", `  Full text: ${dim(`loopfile unpack ${src}@${sha.slice(0, 7)} ./look`)}`, "", select(trustOptions));
  return lines.join("\n");
}

// C: the short header, plus a fourth option that pages the whole Loopfile and comes back.
function variantC() {
  const opts = ["Show the Loopfile", ...trustOptions];
  const prompt = [
    `${yellow("?")} ${bold(src)} (${ref} @ ${sha.slice(0, 7)}) is not on your trust list.`,
    "",
    select(opts),
  ].join("\n");
  const shown = [
    dim(`── Show the Loopfile: opens $PAGER on this text, then the select comes back ──`),
    dim("── manifest.yaml ──"),
    manifestText.split("\n").slice(0, 8).join("\n"),
    dim("… (rest of manifest.yaml)"),
    dim("── prompts/implement.md ──"),
    dim("… (every prompt file, in step order)"),
  ].join("\n");
  return `${prompt}\n\n${shown}`;
}

const variants = { A: variantA, B: variantB, C: variantC };
const pick = process.argv[2]?.toUpperCase();
for (const [name, fn] of Object.entries(variants)) {
  if (pick && pick !== name) continue;
  console.log(`\n${"═".repeat(20)} Variant ${name} ${"═".repeat(20)}\n`);
  console.log(fn());
}
