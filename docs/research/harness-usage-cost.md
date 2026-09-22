# Usage and cost data from each harness adapter

Research for #42. Date: 2026-09-22. Versions: Claude Code 2.1.278, pi 0.85.1.

## Short answer

- There are two adapters: `claude` and `pi` (`src/adapters/harness-adapters.ts`).
  No other harness exists. The fake harness is for tests only.
- Both harnesses give input, output, cache-read and cache-write tokens,
  reasoning tokens, and a cost in USD for one attempt.
- Both costs are **list-price estimates** that the harness computes on the
  client. Neither is a billed amount. On a subscription login, nothing is
  billed per token at all.
- Loopfile keeps the raw output of every call in the attempt folder. It keeps
  only the **last** call's parsed metrics in `status.json`. It does not keep
  a total per attempt or per run.

## Where the output is kept

- `src/adapters/harness-call.ts` writes the raw stdout and stderr of each
  harness call to a file, byte for byte, and parses each line as it passes.
- An agent step writes to `runs/<runid>/attempts/<nnn>-<step>/stdout`.
  A Ralph step writes one file per iteration:
  `runs/<runid>/attempts/<nnn>-<step>/iterations/<nn>/stdout`
  (`src/adapters/attempt-directory.ts`).
- The folder is never written again after the attempt ends. So the full usage
  data of every attempt is on disk after the run.
- Real example: `~/.loopfile/runs/20260921-085256-t77d/attempts/004-review/stdout`
  (claude) and `.../002-implement/stdout` (pi).

## What the adapters parse today

Both adapters give one `metrics` activity per call with this shape
(`StatusMetrics` in `src/domain/status.ts`):
`inputTokens`, `outputTokens`, `totalTokens`, `costUsd`, `toolCalls`.
`inputTokens` includes cached input for both harnesses.

They drop these fields: cache read vs. cache write, reasoning tokens, model
name, per-model cost, and cost basis.

`src/application/harness-activity.ts` line 44 **replaces** `metrics` with each
new metrics activity. It does not add. So `status.json` shows the last call's
numbers, not the run total that the doc comment on `StatusMetrics` says.
Real example: run `20260921-153324-mxl2` has `costUsd` 0.478 in `status.json`.
That is the claude review attempt only. The pi implement attempt before it
cost 0.276 (sum of its `message_end` costs), and that value is gone from
`status.json`. `status.json` also resets to `null` metrics on resume (ADR 0007).

## claude

Command: `claude -p --output-format stream-json --verbose`
(`src/adapters/claude-harness.ts`).

### Fields

The final `result` event has everything. Real example from
`20260921-085256-t77d/attempts/004-review/stdout`:

| Field | Value | Meaning |
|---|---|---|
| `total_cost_usd` | 0.456187 | Estimated cost of the whole call, subagents included |
| `usage.input_tokens` | 16 | Uncached input |
| `usage.cache_creation_input_tokens` | 27326 | Cache write |
| `usage.cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` | 27326 / 0 | Cache write split by TTL |
| `usage.cache_read_input_tokens` | 243344 | Cache read |
| `usage.output_tokens` | 2447 | Output |
| `usage.output_tokens_details.thinking_tokens` | 628 | Reasoning tokens |
| `modelUsage.<model>` | `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `thinkingTokens`, `costUSD`, `costBasis` | Per model, subagents included |
| `modelUsage.<model>.costBasis` | `"list"` | Which price table priced it |
| `num_turns`, `duration_ms`, `duration_api_ms` | 9, 25342, 25012 | Other counts |

All 56 claude `result` events under `~/.loopfile/runs/` have `costBasis: "list"`.
The `init` event has `apiKeySource: "none"`: these runs use the subscription
login, as the adapter intends.

### List price or billed

It is a list-price estimate. The Agent SDK cost-tracking doc
(<https://code.claude.com/docs/en/agent-sdk/cost-tracking>) says:

> The `total_cost_usd` and `costUSD` fields are client-side estimates, not
> authoritative billing data. The SDK computes them locally from a price table
> bundled at build time, unless a `modelPricing` table is in effect.

And: "`costBasis` says which price table priced that model's latest request:
`list` for list price, `managed` for a `modelPricing` table, or `unknown` when
neither matched the model ID."

On a Pro/Max subscription the user pays a flat fee, so this number is what the
same tokens would cost on the API. It is not money spent.

### Traps (same doc)

- `usage` counts only the top-level loop. `total_cost_usd` and `modelUsage`
  include subagents. The adapter takes tokens from `usage` and cost from
  `total_cost_usd`, so with subagents its tokens are too low for its cost.
  `modelUsage` summed over models is the whole-tree token count.
- `assistant` events repeat the same `message.id` and usage for each content
  block (seen in the real file). Their `output_tokens` is a placeholder. Do not
  sum them. Read the `result` event only. The adapter already does this.
- A crash gives an `error_during_execution` result that may have all cost
  fields zeroed.
- A resumed session's result includes the earlier spend (v2.1.277 and later).
  The adapter never resumes a session, so this does not apply today.
- `thinking_tokens` is under `output_tokens_details`. The fetched doc does not
  say whether it is part of `output_tokens`. Treat it as a detail of output,
  not something to add.

## pi

Command: `pi -p --mode json --no-session` (`src/adapters/pi-harness.ts`).

### Fields

Each assistant `message_end` event has `message.usage`, plus `message.model`,
`message.provider` and `message.api`. Real example from
`20260921-085256-t77d/attempts/002-implement/stdout`:

```json
{"input":2889,"output":201,"cacheRead":6656,"cacheWrite":0,"reasoning":26,
 "totalTokens":9746,
 "cost":{"input":0.0005778,"output":0.0002412,"cacheRead":0.00013312,"cacheWrite":0,"total":0.00095212}}
```

with `model: "gpt-5.6-luna"`, `provider: "openai-codex"`.

The `Usage` type in `@earendil-works/pi-ai` (`dist/types.d.ts`) defines:

- `input`: uncached input. `cacheRead`, `cacheWrite`: cached input.
  `totalTokens` = input + output + cacheRead + cacheWrite (9746 above).
- `cacheWrite1h`: part of `cacheWrite` with 1h TTL. Anthropic only.
- `reasoning`: "a subset of `output`: `output` already includes these tokens".
  Left out by providers that do not report it.
- `cost.{input,output,cacheRead,cacheWrite,total}` in USD.

Count only `message_end` with `role: "assistant"`. The same usage repeats on
`turn_end` and inside `agent_end.messages`. `docs/json.md` in the pi package
says "`message_end` contains the final authoritative message". The
`message_update` events carry a running `usage` that "may remain zero".

pi can retry: `agent_end` has `willRetry`. Real example:
`20260921-153324-mxl2/attempts/002-implement/stdout` has two `agent_end`
events, the first with `willRetry: true`. The adapter sums every assistant
`message_end` over both, which is right, because each is a separate request.

### List price or billed

It is a list-price estimate from pi's model catalog. `calculateCost` in
`@earendil-works/pi-ai/dist/models.js` multiplies the token counts by
`model.cost` rates per million tokens (with price tiers above an input size,
and 2x input price for Anthropic 1h cache writes). The rates come from the
built-in catalog or `~/.pi/agent/models-store.json`. For `openai-codex`
`gpt-5.6-luna` they are input 0.2, output 1.2, cacheRead 0.02 per million,
which matches the example above (2889 x 0.2 / 1e6 = 0.0005778).

What the user really pays depends on the login (pi `docs/providers.md`):

- `openai-codex` (the runs here) "Requires ChatGPT Plus or Pro subscription".
  Flat fee, so the cost is notional.
- Claude Pro/Max through pi "draws from extra usage and is billed per token".
  There the estimate is close to real money, but still not a billed figure.
- An API key provider bills per token; pi's number is still its own estimate.

pi's output has no field like `costBasis` that tells these cases apart.
`message.provider` is the best hint.

## Summary table

| | claude | pi |
|---|---|---|
| Where | last `result` event | sum of assistant `message_end` events |
| Uncached input | `usage.input_tokens` | `usage.input` |
| Cache read / write | `cache_read_input_tokens` / `cache_creation_input_tokens` | `cacheRead` / `cacheWrite` |
| Reasoning | `output_tokens_details.thinking_tokens`, `modelUsage.*.thinkingTokens` | `reasoning` (subset of `output`, may be missing) |
| Cost | `total_cost_usd`, `modelUsage.*.costUSD` | `cost.total` (and parts) |
| Cost kind | list-price estimate, says so in `costBasis` | list-price estimate from catalog, no marker |
| Model | keys of `modelUsage` | `message.model`, `message.provider` |
| Kept raw | yes, attempt `stdout` | yes, attempt `stdout` |
| Kept parsed | last call only, `status.json`, input+output+cost | same |

## Sources

- Adapter code: `src/adapters/claude-harness.ts`, `src/adapters/pi-harness.ts`,
  `src/adapters/harness-call.ts`, `src/adapters/attempt-directory.ts`,
  `src/application/harness-activity.ts`, `src/domain/status.ts`, ADR 0007.
- Claude Code docs: <https://code.claude.com/docs/en/agent-sdk/cost-tracking>.
- pi 0.85.1 package: `docs/json.md`, `docs/providers.md`,
  `node_modules/@earendil-works/pi-ai/dist/types.d.ts` (`Usage`),
  `node_modules/@earendil-works/pi-ai/dist/models.js` (`calculateCost`),
  `~/.pi/agent/models-store.json`.
- Real output: `~/.loopfile/runs/20260921-085256-t77d/` and
  `~/.loopfile/runs/20260921-153324-mxl2/`, read only.
