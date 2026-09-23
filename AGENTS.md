## Agent skills

### Issue tracker

Issues live in GitHub Issues for `nordbotten/loopfile`, used through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Quality guardrails

Run `npm run verify` before you finish. CI runs the same script, so a failure
there is one you could have seen locally. CI and the ticket loop also run
`npm run quality:mutation`. A loop agent never runs it. In a session with a
person, run it when you have changed `CORE`. Never add a suppression under `src/` — no `@ts-expect-error`, no
`biome-ignore`, no skipped test. A file under `src/` is `CORE` unless the zone
map says otherwise, and `CORE` may not import the filesystem, processes or a
harness SDK; that code belongs under `src/adapters/`. Never edit a bar in
`quality/quality-ratchet.json` to make a check pass. See
[`quality/QUALITY.md`](quality/QUALITY.md) and
[ADR 0009](docs/adr/0009-quality-guardrails.md).
