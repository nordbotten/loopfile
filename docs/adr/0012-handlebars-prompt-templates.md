# Prompts are Handlebars templates without custom helpers

A prompt author must control what an agent sees, including the value history of a key and the run facts, in the prompt file alone, with no step that prepares the text (#241). That needs a template language that can repeat text for each item of a list and show or leave out text, but that holds no code, because other people write the prompts and the loader must check every name a prompt reads. We picked Handlebars with only its built-in blocks, so authors get a known language, and the run owner gets a parse tree to check and a renderer that reads no outer level for a missing name.

## Decisions

- **Engine (#259):** a prompt is a Handlebars template over prompt data (ADR 0005). `CORE` imports the build at `handlebars/dist/cjs/handlebars.js`, because the main entry reads files with `fs` and adds a global loader for `.hbs` files.
- **Allowed features (#259):** plain placeholders, the blocks `if`, `unless`, `each` and `with`, `else`, the names `@first`, `@last` and `@index`, and `../` to read an outer level. The run owner registers no helper of its own, so a prompt holds no code.
- **Refused at load (#245, #259):** `lookup`, because it builds a name at run time that the loader cannot check. `log`, because it writes to the console. Partials, inline partials and decorators, because a prompt is one file. A prompt that does not parse is a load error with the prompt line in the message.
- **Same text as before (#242):** HTML escaping is off. A name with no value fills as an empty string. `{{ test.log }}` still finds the data key `test.log`, because the run owner builds a nested view from the flat data keys.
- **Every field is set (#246, #259):** every documented field of prompt data is always set, and an empty value is `""`, never a missing field, so `{{#if}}` acts the same for every field.

## Considered Options

- **A logic-less engine with no helpers at all:** the same blocks, but it reads outer levels for a name an item does not have, it cannot turn off partials or a change of delimiters, and the one package for it has had no release since 2021.
- **A parser of our own for a small subset:** no new package and exact rules, but the project owns a template language for good, and authors must learn a subset they cannot look up.
- **Liquid:** maintained, with one package and a sandbox made for authors other than the developer. Its filters and comparisons, such as `where` and `>`, are code in a prompt, and it refuses `$` in a name, so `$run` and `$history` (#245) would need other names.
- **Handlebars with custom helpers, for example `eq`:** prompts could compare values, but a helper is code the loader cannot check, and each one is a surface to keep for good. The flags `lastAttempt` and `lastIteration` (#255) cover the comparisons authors need.

## Consequences

- Handlebars adds four packages and one optional package to the runtime dependencies. It is the first one that `CORE` imports.
- Handlebars compiles a template to a JavaScript function with `new Function`. The template text comes from the Loopfile, which the operator chose to run.
- Handlebars has had prototype pollution bugs. They are fixed in 4.6 and later, and the run owner gives it a view of plain data only.
- A prompt that has `{{` text meant for the agent must escape it as `\{{`.
