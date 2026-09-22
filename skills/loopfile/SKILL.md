---
name: loopfile
description: Use Loopfile when you want an agent to run a deterministic software-engineering workflow and follow its result without a terminal.
---

# Loopfile

Use Loopfile to run a deterministic software-engineering workflow and follow it from outside the run.

## Operator flow

1. Read `loopfile docs manifest` for the manifest format.
2. Write the manifest to standard input and run `loopfile check - --json` until it reports no problems.
3. Start it with `loopfile - -d`; take the run ID from stdout.
4. Follow the run with `loopfile tail <runid> --json` until it ends.
5. Read the result with `loopfile result <runid> --json`.
6. On failure, act on the reported end reason or code.
7. Remove the run with `loopfile remove <runid>`.
