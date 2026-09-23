# Node.js + TypeScript stack, Linux and macOS, shipped as an npm package

Loopfile is written in TypeScript and runs on Node.js `>=24`. It supports Linux and macOS and is installed as an npm package. We picked Node over Bun and Deno because our users already have Node for their harnesses (Claude Code, Codex, Gemini CLI), and Node has the best-documented detach and signal behavior. Research: [Compare TypeScript runtime and tooling options](https://github.com/nordbotten/loopfile-archive/issues/53).

## Decisions

- **Platforms:** Linux and macOS. Windows comes later. Code uses portable `node:` APIs so Windows stays possible without a rewrite.
- **Distribution:** npm package (`npm i -g loopfile`). A single executable comes later.
- **Node version:** `>=24` (Node 22 LTS ends April 2027).
- **Package manager:** npm.
- **Build:** `tsc` only, emitting JS to `dist/`, with `erasableSyntaxOnly` so Node can also run the `.ts` source directly. No bundler.
- **Modules:** ESM only; `.ts` import extensions, rewritten by `rewriteRelativeImportExtensions`.
- **Tests:** `node:test`.
- **Lint and format:** Biome.
- **CLI parsing:** `util.parseArgs`, no framework.
- **Monitor rendering:** plain ANSI with `node:readline` and `util.styleText`. No Ink/React.
- **Tar:** `tar` (node-tar). **YAML:** `yaml`. **Git:** spawn the `git` binary for Remote Loopfiles and worktree creation. Git is optional for workspace modes: every mode works without it, and `isolate` falls back to a full copy when Git cannot make a worktree (ADR 0014). Remote Loopfiles need Git (ADR 0013).

## Considered Options

- **Bun:** built-in tar and `--compile`, but its native APIs lock code to Bun, and users must install Bun.
- **Deno:** most built-in tooling, but `@std/tar` is unstable without compression, and users must install Deno and grant permissions.
- **Windows in MVP:** rejected for now. It has no real signals, so graceful cancel of a detached run needs a second channel, and rename-over has no stated atomicity guarantee.
- **Single executable in MVP:** rejected for now. Node SEA is Stability 1.1 and does not support macOS x64.
- **Vitest, ESLint + Prettier, Oxlint, commander, Ink:** each adds dependencies the MVP does not need. Move to Oxlint if Biome misses unawaited-promise bugs. Move to Ink if the monitor grows to several panels (only monitor code changes).

## Consequences

- Graceful cancel and detach design may rely on POSIX signals and `setsid` for the MVP.
- State writes use write-temp-then-rename, which is atomic on both supported platforms.
