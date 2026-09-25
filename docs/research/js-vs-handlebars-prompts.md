# JS template strings or Handlebars for prompts

Question: should a Loopfile prompt be a JS template string (`${ }`) in place of a
Handlebars template? Step fields `model` and `effort` already become JS template
strings, parsed with `jsep` 1.4.0 and `@jsep-plugin/template`, and walked by our
own code (no calls, no `[ ]`, no `eval`). This note collects the facts. It does
not make the decision.

Research date: 2026-09-25. Probe results come from a scratch install of
`handlebars@4.7.9`, `jsep@1.4.0`, `@jsep-plugin/template@1.0.5` and
`@jsep-plugin/arrow@1.0.6` on Node 24.

## Summary

- **Loops need calls.** A JS template string has no loop. To repeat text for each
  `$history` entry, a prompt must write `${list.map(e => `...`).join("")}`. The
  field subset refuses calls and has no arrow functions, so the prompt subset must
  add `@jsep-plugin/arrow`, calls, and an allowlist of methods (at least `map` and
  `join`). Show or hide works in the field subset: `${ok ? `text` : ""}`.
- **Almost every prompt uses backticks.** The 6 prompt files and 1 of 2 inline
  prompts hold 144 backticks (inline code) and 0 `${`. If the loader wraps the prompt in
  backticks as it does for fields, each backtick ends the string: the author must
  write `` \` ``, or the loader needs its own `${` scanner.
- **`{{` does not collide today.** The same 7 prompts hold 74 `{{`, and every one
  is a placeholder or a block. None is text for the agent. No prompt uses `\{{`.
- **Name checks stay possible with a `jsep` walk.** Arrow parameters are a local
  scope, as an `each` item is today. With Node `vm`, QuickJS, `isolated-vm` or SES,
  the code runs as real JS, so the loader needs a second, full parser to check
  names, and computed names can still escape the check.
- **Only a `jsep` walk is small and safe by design.** Node says `vm` "is not a
  security mechanism". `isolated-vm` is in maintenance mode and needs a C++
  compiler. QuickJS adds about 2.4 MB plus wasm files. SES changes the whole realm
  and does not stop endless loops.
- **Most prompt tools use `{{ }}`.** Anthropic Console, Semantic Kernel, Dotprompt,
  Promptfoo, LangChain (mustache, jinja2), Prompty, Helm and Ansible use `{{ }}`.
  JS `${ }` shows up where the prompt lives in application code, which OpenAI now
  recommends in place of its prompt objects.
- **Handlebars has a working escape, JS has two.** Handlebars needs `\{{`. A JS
  prompt needs `\${` and, if wrapped, `` \` ``. Neither has a raw block that
  Loopfile allows: Handlebars raw blocks need a helper, and `String.raw` does not
  stop `${ }` filling.
- **A hybrid is possible.** Keep Handlebars blocks and let a plain placeholder hold
  the field expression form (`{{ a ?? b }}`). The loader already rewrites tags
  before the Handlebars parse, but the cost is two grammars in one prompt.

## 1. What prompts need that fields do not

A field makes one short value. A prompt must also do three things (ADR 0012,
`docs/manifest-v1.md`):

1. Repeat text for each item of a list, for example each entry of
   `$history.review.feedback`.
2. Show or hide text.
3. Read an outer name inside a loop (`../` in Handlebars).

The table uses the pattern from `loops/ticket/prompts/fix.md`.

| Need | Handlebars today | JS template string |
|---|---|---|
| Show text | `{{#if $run.previous}}...{{/if}}` | `${$run.previous ? `...` : ""}` |
| Hide text | `{{#unless newest}}...{{/unless}}` | `${!e.newest ? `...` : ""}` |
| Else | `{{#if a}}x{{else}}y{{/if}}` | `${a ? `x` : `y`}` |
| Repeat | `{{#each $history.review.feedback}}### Review {{ attemptId }}{{/each}}` | `${$history.review.feedback.map(e => `### Review ${e.attemptId}`).join("")}` |
| First item | `{{#if @first}}` | `${e.index === 1 ? ...}` (history entries have `index` from 1) |
| Last item | `{{#if @last}}` | `${e.newest ? ...}`. `i === xs.length - 1` does not work: `-` is a name character and not an operator in the field subset. |
| Outer name in a loop | `{{ ../input.task }}` | `${input.task}` (closures read outer names) |
| `with` | `{{#with $run.previous}}{{ stepId }}{{/with}}` | No equivalent. Write the full path. |
| Comment | `{{! text }}` (used in `fix.md`) | None without `@jsep-plugin/comment`: `${/* text */ ""}` |

**Show or hide works in the field subset.** It needs `? :`, `!`, and a nested
template string. The probe parsed `` `a ${x ? `b ${y}` : ''} c` `` with the
template plugin alone. MDN documents nested templates in `${ }`
([MDN template literals](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals)).

**Repeat does not work without calls.** A template literal has no loop form
(MDN). The only ways to repeat text are:

- `list.map(item => `...`).join("")`. This needs a call, member calls, and an arrow
  function.
- A fixed field that the run owner joins, for example a ready-made Markdown list
  of the history. This takes the item format away from the author, which ADR 0012
  says a prompt author must control (#241).

**What the prompt subset must add to the field subset:**

| Addition | Why | `jsep` support |
|---|---|---|
| Arrow functions, expression body only | the item of a loop | `@jsep-plugin/arrow` 1.0.6. The probe: `e => ...` and `(e, i) => ...` parse; `({value}) => value` and `function (x) {...}` fail. |
| Member calls, allowlist only | `map`, `join`, maybe `filter` | Core `jsep` parses `CallExpression` by default. The walker must refuse every callee that is not an allowlisted method. |
| Arrow parameters as a local scope | name checks | Our walker. Same idea as the `each` item scope in `src/application/prompt-check.ts`. |
| Refuse names such as `constructor`, `__proto__`, `prototype` | prototype access | Our walker. If the walker runs `map` itself, it never calls a real method. |
| A rule for truthiness of a list | `if` over a list | Our walker. Handlebars `if` treats `[]` as false ([built-in helpers](https://handlebarsjs.com/guide/builtin-helpers.html)). In JS, `[]` is truthy ([MDN Truthy](https://developer.mozilla.org/en-US/docs/Glossary/Truthy)). So `${$history.x ? ... : ""}` shows text for an empty list, unless the walker adds `.length` or its own rule. |

State of the plugins (npm registry, `npm view`):

| Package | Version | Last publish | Unpacked size |
|---|---|---|---|
| `jsep` | 1.4.0 | 2024-11-05 | 392 kB (12 kB minified build) |
| `@jsep-plugin/template` | 1.0.5 | 2024-11-05 | 42 kB |
| `@jsep-plugin/arrow` | 1.0.6 | 2024-11-05 | 30 kB |
| `@jsep-plugin/comment` | 1.0.4 | 2024-11-05 | not measured |

All plugins live in the `jsep` monorepo and were last published on the same day
as `jsep` 1.4.0 ([jsep README](https://github.com/EricSmekens/jsep),
[arrow plugin](https://github.com/EricSmekens/jsep/tree/master/packages/arrow)).
The arrow README gives only examples (`a.find(v => v === 1)`,
`a.map((v, i) => i)`). It does not document limits. `jsep` only parses. It
"can parse JavaScript expressions but not operations", so the evaluation is our
code (jsep README).

Other facts from the probe:

- Whitespace. Handlebars removes a line that holds only a block tag (standalone
  lines) and has `~` for whitespace control
  ([expressions guide](https://handlebarsjs.com/guide/expressions.html)). A JS
  template keeps every newline, so a JS prompt must put the `${ ... }` of a block
  on the lines of the text around it.
- Empty names. Today a name with no value fills as `""` (ADR 0012). For fields,
  `${undefined}` fails the attempt. A prompt needs one rule for both.
- Lists. Today a list in a plain placeholder fills as JSON (manifest-v1). In JS,
  `${[1,2]}` is `1,2`. Our walker decides, so this can stay JSON.

## 2. Safety

**Name checks.** The loader checks every name a prompt reads before the run
(ADR 0005, "Prompt filling"). With a `jsep` walk this stays possible. Each name is
an `Identifier` or a chain of non-computed `MemberExpression` nodes, and `[ ]`
access is refused. Arrow parameters add a local scope. With real JS (any of the
engines below), a prompt can build a name at run time, for example
`obj[k]` or `Object.keys(...)`. ADR 0012 refuses Handlebars `lookup` for the same
reason. To check names before the run, the loader would still need a full JS
parser (for example acorn) and a rule that refuses most of JS, which brings back
the walk.

| Option | Security boundary? | Size and upkeep | Last release |
|---|---|---|---|
| `jsep` tree walk (our code) | Yes by design: nothing runs that we did not write. The field walker is about 30 lines. A prompt walker with arrows, scopes and a method allowlist is larger (estimate: 100 to 200 lines; today `prompt-check.ts` plus `prompt-fill.ts` is 524 lines). | `jsep` has no dependencies. | `jsep` 1.4.0, 2024-11-05 |
| Node `vm` | No. "The `node:vm` module is not a security mechanism. Do not use it to run untrusted code." ([Node vm docs](https://nodejs.org/api/vm.html)) | Built in. | Node |
| QuickJS (`quickjs-emscripten`) | Yes, a wasm sandbox. It "safely evaluate[s] untrusted Javascript", with `setMemoryLimit` and an interrupt handler for time ([README](https://github.com/justjake/quickjs-emscripten)). | 2.4 MB unpacked, plus `quickjs-emscripten-core` (795 kB) and four wasm variant packages (the release-sync one is 650 kB). The host must copy values in and out. | 0.32.0, 2026-02-16 (0.x) |
| `isolated-vm` | A V8 isolate, but "use of isolated-vm to run untrusted code does not automatically make your application safe". The project "is currently in maintenance mode" ([README](https://github.com/laverdet/isolated-vm)). | Native module, needs a C++ compiler at install, 21 MB unpacked. Needs `--no-node-snapshot` on Node 20 and later. Each Node major needs a matching major (6.x for Node 24, 7.x for Node 26). | 7.0.1, 2026-08-05 |
| SES / `@endo` | Partly. `lockdown()` "alters the surrounding execution environment", so the whole process changes. Guest code "can execute for an indefinite amount of time" and "allocate arbitrary amounts of memory" ([SES README](https://github.com/endojs/endo/tree/master/packages/ses)). | `ses` is 4.7 MB unpacked with three `@endo` dependencies. | `ses` 2.3.0, 2026-08-13 |

Notes:

- Handlebars today compiles a template to a function with `new Function`
  (ADR 0012). The input is checked first and the view holds plain data only.
- A remote Loopfile passes a trust prompt (ADR 0013). A trust prompt is a person's
  choice, not a sandbox. With a `jsep` walk or today's checked Handlebars, a
  prompt cannot run code, so the trust prompt covers the harness, not the
  template.
- For fields, the decision is already a `jsep` walk. A prompt engine with real JS
  would give the same Loopfile two safety models.

## 3. Compatibility

Counted with `grep -o` on the tracked files. "Text for the agent" means text that
the author wants the agent to see as it is, not a placeholder.

### The prompts

| File | Lines | `${` | Backticks | `{{` (all placeholders or blocks) | `\{{` |
|---|---|---|---|---|---|
| `loops/ticket/prompts/describe.md` | 43 | 0 | 40 (two `sh` code fences) | 2 | 0 |
| `loops/ticket/prompts/fix.md` | 75 | 0 | 20 | 43 | 0 |
| `loops/ticket/prompts/implement.md` | 20 | 0 | 16 | 1 | 0 |
| `loops/ticket/prompts/resolve.md` | 37 | 0 | 18 | 9 | 0 |
| `loops/ticket/prompts/review.md` | 66 | 0 | 38 | 15 | 0 |
| `examples/implement-review/prompts/implement.md` | 20 | 0 | 8 | 3 | 0 |
| **Total (6 files)** | 261 | **0** | **140** | **73** | **0** |

Inline `prompt:` fields: `examples/implement-review/manifest.yaml` (the `review` step: 1 `{{ }}`
placeholder, 4 backticks, no `${`) and
`examples/minimal/manifest.yaml` (one, no markers). `loops/ticket.loop` in the
main checkout is an untracked binary bundle and is not counted.

Tests: 8 test files hold 93 lines with `{{` (for example
`src/application/load-workflow.test.ts` 34, `src/adapters/workflow-run.test.ts`
18, `src/application/prompt-check.test.ts` 14). These are Handlebars cases that
a switch must rewrite. No test prompt holds a literal `${`. The one `\${` in
`src/adapters/workflow-run.test.ts:1028` is a step command, not a prompt. One test
(`workflow-run.test.ts:1104`) checks the `\{{` escape.

Docs: `${` 0 times in `README.md`, `CONTEXT.md`, `docs/*.md` and
`skills/loopfile/SKILL.md`. `{{` shows in `CONTEXT.md` (5), `docs/loop-patterns.md`
(6), `docs/manifest-v1.md` (3), `docs/runtime.md` (2). `\{{` shows twice, both
to document the escape.

**Result.** If `${` starts to fill values, no current prompt text breaks through
`${`. But the 144 backticks break if the loader wraps the whole prompt in
backticks, as it does for fields. The probe shows what happens:
`` `run `git log` now` `` parses as a `Compound` of a template, a name and a
tagged template. The walker refuses it, so it is a load error, not a silent
wrong fill. All 7 prompts (6 files, 1 inline) would fail to load until each backtick is `` \` ``.
The other way out is a scanner of our own that finds `${`, finds the matching
`}` and gives only the inside to `jsep`. That scanner must skip strings and
nested templates inside the expression.

### How often each marker shows up in text that prompts hold

A prompt often holds shell, code and config for the agent to read or run.

| Kind of text | `${` | `{{` | Source |
|---|---|---|---|
| Shell | Core syntax: `${parameter}`, `${parameter:-word}` | Not used | [Bash manual, parameter expansion](https://www.gnu.org/software/bash/manual/html_node/Shell-Parameter-Expansion.html) |
| JS / TS | Core syntax of template literals, and backticks around them | Only in object literals | [MDN template literals](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals) |
| GitHub Actions YAML | Yes: `${{ <expression> }}` | Yes: the same `${{` | [GitHub expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions) |
| Jinja / Go templates / Helm | Not used | Core syntax: `{{ .Values.x }}`, `{{ if }}`, `{{ range }}` | [Helm control structures](https://helm.sh/docs/chart_template_guide/control_structures/), [Ansible templating](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_templating.html) |
| Markdown | Not used | Not used | Backticks mark all inline code and code fences. |

Counts in this repo's own files, as a sample:

| Files | `${` | `{{` | Backticks |
|---|---|---|---|
| `scripts/*.sh` (2 files) | 3 | 0 | not counted |
| `.github/workflows/*.yml` (3 files) | 8 (all `${{`) | 8 (the same) | not counted |
| `src/**/*.ts`, no tests | 956 | 9 | 4106 |
| `docs/*.md` | 0 | 11 | 1884 |

When a collision happens, both options mostly fail loud: the name is not a
declared input or step output, so the loader refuses it (ADR 0012,
`docs/manifest-v1.md`). Shell `${HOME}` in a JS prompt is a load error. GitHub
`${{ x }}` in a JS prompt parses as an object literal, which is refused. The same
text in Handlebars is `$` plus a placeholder `x`, also a load error. A collision
fills silently only when the text uses a real root name (`input`, a step ID,
`$run`, `$history`).

### Escapes and raw blocks

| | Handlebars | JS template string |
|---|---|---|
| Escape one marker | `\{{` (probe: `\{{x}}` fills as `{{x}}`) ([expressions guide](https://handlebarsjs.com/guide/expressions.html)) | `\${` (MDN: `` `\${1}` === "${1}" ``) |
| Escape a backtick | Not needed | `` \` `` if the prompt is wrapped in backticks (MDN) |
| Raw block for a whole code block | `{{{{raw}}}} ... {{{{/raw}}}}` exists, but it calls a helper named `raw` (expressions guide). With no helper, the probe renders `A {{{{raw}}}}echo {{x}}{{{{/raw}}}} B` as `A  B`: the content is lost. The Loopfile checker refuses any block that is not `if`, `unless`, `each` or `with`, so it is a load error today. | None. `String.raw` does not stop `${ }` filling: `` String.raw`Hi\n${2 + 3}!` `` is `Hi\n5!` (MDN). A raw form would be a rule of our own, for example "code fences are not filled". |

## 4. Familiarity

What other tools use for prompt and workflow templates, from their official docs.

| Tool | Fill | Blocks | Code inside? | Source |
|---|---|---|---|---|
| Anthropic Console | `{{text}}`, "denoted with {{double brackets}}" | Not documented | No | [Console prompting tools](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompt-templates-and-variables) |
| OpenAI prompt objects | Variables in a `variables` object | Not documented | No | Prompt objects are deprecated. `v1/prompts` "is scheduled to shut down on November 30, 2026". The migration guide moves prompts into code with JS `${name}` or Python f-strings ([migration guide](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object)). |
| LangChain Python `PromptTemplate` | f-string `{x}` (default), `jinja2`, or `mustache` | jinja2 and mustache | jinja2: "NEVER accept jinja2 templates from untrusted sources as they may lead to arbitrary Python code execution" | [PromptTemplate reference](https://reference.langchain.com/python/langchain-core/prompts/prompt/PromptTemplate) |
| LangChain.js / LangSmith | f-string `{x}` or mustache `{{x}}` | mustache sections | No | [Prompt template format](https://docs.langchain.com/langsmith/prompt-template-format) |
| Promptfoo | Nunjucks `{{name}}` | `{% if %}`, filters | Not stated | [Promptfoo parameters](https://www.promptfoo.dev/docs/configuration/parameters/) |
| Semantic Kernel | `{{$var}}`, plus Handlebars and Liquid "which allows you to use loops, conditionals" | In Handlebars or Liquid | Function calls only, `{{ns.fn $var}}` | [SK template syntax](https://learn.microsoft.com/en-us/semantic-kernel/concepts/prompts/prompt-template-syntax) |
| Google Dotprompt (Firebase) | Handlebars `{{name}}` | `{{#if}}`, `{{#each}}` with `@first`, `@last`, `@index`. "Conditionals only accept a variable reference, not any type of expression" | No | [Dotprompt syntax](https://firebase.google.com/docs/ai-logic/server-prompt-templates/syntax-and-examples) |
| Microsoft Prompty | Jinja2 (default) or Mustache | Yes | Jinja2 | [Prompty](https://github.com/microsoft/prompty) |
| DSPy | No text template. Adapters build the prompt from typed signatures. | n/a | Python code | [DSPy signatures](https://dspy.ai/current/diving-deeper/signatures-in-depth/) |
| GitHub Actions | `${{ <expression> }}` | `if:` keys, built-in functions (`contains`, `format`, `join`, `toJSON`) | Fixed functions, not JS | [GitHub expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions) |
| Ansible | Jinja2 `{{ var }}` | Jinja2 | Jinja2 filters and tests | [Ansible templating](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_templating.html) |
| n8n | `{{ $json.city }}` with "JavaScript-like code" inside, through its own engine, Tournament | JS inside the braces | Yes, JS-like | [n8n Code docs](https://docs.n8n.io/code/), [expression reference](https://docs.n8n.io/build/work-with-data/transform-data/expression-reference) |
| Zapier | Named variables, `name(value)` | Not documented | No | [Zapier named variables](https://community.zapier.com/featured-articles-65/create-your-own-fields-with-named-variables-9138) (a Zapier community article, not a product doc) |
| Helm | Go templates `{{ .Values.x }}` | `{{ if }}`, `{{ range }}`, `{{ with }}` | Functions and pipelines only | [Helm control structures](https://helm.sh/docs/chart_template_guide/control_structures/) |

Tally: of the prompt tools with a template language (Anthropic Console,
LangChain, Promptfoo, Semantic Kernel, Dotprompt, Prompty), all use `{{ }}`.
Dotprompt is the closest match to Loopfile: Handlebars, the same `@first`,
`@last`, `@index`, and no expressions in `if`. Among workflow tools, GitHub Actions
uses `${{ }}` with a fixed function set, and n8n puts JS inside `{{ }}`. No tool
in this list uses bare JS template literals as its prompt file format. JS `${ }`
is common where a developer writes the prompt inside application code, which is
what OpenAI now recommends.

The user's point holds for developers: JS is known, and it can do more. But
"more" here means calls and arrow functions. The field subset refuses both, and
the prompt subset must add them back in a controlled form.

## 5. Middle options

| Option | What it is | Cost |
|---|---|---|
| A. Keep Handlebars (today) | Fields use `${ }`, prompts use `{{ }}`. | Two syntaxes in one Loopfile. Each maps to one job: a field is one expression, a prompt is text with blocks. No prompt changes. Handlebars stays in `CORE` (4 packages plus 1 optional, ADR 0012). |
| B. Handlebars blocks, field expressions in plain placeholders | `{{ $run.attempt.number ?? 1 }}` or `{{ ok ? "a" : "b" }}`. Blocks stay `{{#if}}`, `{{#each}}`. | Handlebars cannot parse `??` or `? :`. The loader must cut the inside of each plain tag out before the Handlebars parse and give it to `jsep`. `quotePromptNames` in `src/application/prompt-check.ts` already rewrites each tag before the parse, so there is a place for it. Costs: two grammars in one prompt, and block arguments stay plain names unless the same trick is used there. |
| C. Full JS with arrows and a method allowlist | Section 1: `@jsep-plugin/arrow`, calls, `map`, `join`, local scopes, a list truthiness rule. | One syntax across the Loopfile. Adds a plugin and a larger walker that the project owns. Every backtick in a prompt needs `` \` ``, or we write our own `${` scanner. All 7 prompts and about 93 test lines change. No `with`, no comments, no standalone-line whitespace rule. |
| D. JS without loops | Only the field subset in prompts. The run owner gives ready-made text for each history key. | Small. But the author loses control of how each item looks (#241), and the run owner owns a text format for good. |
| E. JS prompts with a raw rule | C, plus "code fences are not filled". | Removes most backtick and `${` collisions for fenced code. Inline code still collides. It is a rule no other tool has, so authors cannot look it up. |
| F. Both engines, picked per prompt | For example by file extension (`.hbs` or `.md`). | Two engines, two checkers and two sets of docs for good. |

## What this means for the choice

- If "one syntax in the Loopfile" matters most, option C gives it. The price is
  a walker with arrows and a method allowlist, an escape for every backtick (or a
  scanner of our own), and a rewrite of all 7 prompts and the Handlebars tests.
- If "prompt authors can look it up" matters most, Handlebars matches the
  prompt tools in section 4, and Dotprompt uses the same subset. No prompt text
  changes.
- If fields need to read like prompts, option B lets a plain placeholder hold a
  field expression, at the cost of two grammars in one tag language.
- Safety does not decide between a `jsep` walk and checked Handlebars. Both let
  the loader check every name. It does decide against `vm`, and it makes QuickJS,
  `isolated-vm` and SES costly for a gain the walk already gives.
- Collisions do not decide much. Both markers fail loud in most cases. The real
  difference is backticks, which are in every prompt, and they matter only if the
  prompt is wrapped in backticks.

## Sources

- Repo: `CONTEXT.md`, `docs/adr/0005-execution-context-contract.md` ("Prompt
  filling"), `docs/adr/0012-handlebars-prompt-templates.md`,
  `docs/adr/0013-remote-loopfiles.md`, `docs/manifest-v1.md`,
  `src/application/prompt-check.ts`.
- npm registry data from `npm view <package> version time dist.unpackedSize
  dependencies engines`, 2026-09-25.
- Node: <https://nodejs.org/api/vm.html>
- jsep: <https://github.com/EricSmekens/jsep>,
  <https://github.com/EricSmekens/jsep/tree/master/packages/arrow>
- QuickJS: <https://github.com/justjake/quickjs-emscripten>
- isolated-vm: <https://github.com/laverdet/isolated-vm>
- SES: <https://github.com/endojs/endo/tree/master/packages/ses>
- Handlebars: <https://handlebarsjs.com/guide/expressions.html>,
  <https://handlebarsjs.com/guide/builtin-helpers.html>
- MDN: <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals>,
  <https://developer.mozilla.org/en-US/docs/Glossary/Truthy>
- Bash: <https://www.gnu.org/software/bash/manual/html_node/Shell-Parameter-Expansion.html>
- Tools: links in the section 4 table.
