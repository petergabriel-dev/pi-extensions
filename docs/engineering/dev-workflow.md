# Dev workflow

## Pi ↔ Claude Code bridge workflow

Use this flow for existing Pi projects:

1. Start/focus Pi in the project first.
2. Confirm bridge is active in Pi footer/status: `Claude bridge: active`.
3. Run Claude Code in the same Pi project or under the intended `.pi` marker.
4. Use Claude Code `/discuss` or `/plan` for planning.
5. Claude Code should use MCP tools from `pi-claude-bridge`:
   - `recall_memory`
   - `capture_note`
   - `validate_docs_tags`
   - `save_plan`
6. Switch to Pi `/mode build` to implement saved plans.

Verification commands used during bridge development:

```bash
node agent/claude-bridge-client/test-core-protocol.js /Users/petergabrielrlopez
claude mcp list
```

Expected MCP server entry:

```text
pi-claude-bridge: node /Users/petergabrielrlopez/.pi/agent/claude-bridge-client/pi-bridge-mcp.js - ✓ Connected
```

Real acceptance checks:

- Claude Code `/discuss` records a decision through `capture_note`; Pi Notes widget updates live.
- Claude Code `/plan` recalls memory, validates docs tags, asks for save confirmation, and calls `save_plan`.
- Pi `/plan view` shows bridge-saved plan.
- Pi `/mode build` keeps saved plan available.
- Claude Code `Edit` and `git commit` are denied in `.pi` projects.
- Claude Code read-only Bash such as `rg` is allowed only through the sandbox hook; if sandboxing is unavailable, Bash denies closed.
- On macOS with `/usr/bin/sandbox-exec`, Claude Code allowed Bash is rewritten through the read-only sandbox hook; inspect hook output with `--include-hook-events` or direct hook smoke tests when debugging.

No-commit note: this `~/.pi` workspace may not be a Git repo. Build checkpoints can be explicit no-commit checkpoints when approved by the user.

## Engineering docs extension workflow

`/docs init` creates managed docs plus root `AGENTS.md` and `CLAUDE.md` spokes. Spokes are repaired by `/docs check` only when writes are allowed (Build/Off). Use `/docs check --check` for validation-only runs; it reports missing marker blocks and dead spoke doc links without writing.

Spoke verification during development:

```bash
cd agent/extensions/engineering-docs
npx --yes tsx test/test_spokes.ts
```

## Workflow-Modes Extension testing

To run typecheck and tests for the workflow-modes sandbox and fallback policy:

```bash
cd agent/extensions/workflow-modes
npm test
npm run typecheck
```

`npm test` runs standalone `tsx` tests for:

- generated sandbox wrapper/profile strings;
- fallback policy allow/deny behavior;
- behavioral sandbox contract when a real launcher is available, otherwise a no-launcher skip path.

## Personal-memory Extension testing

Personal memory command:

```text
/remember <small durable personal preference or lesson>
```

`/remember` appends a dated bullet to `~/.pi/memory.md`. That file is loaded in full on the next agent turn by `agent/extensions/personal-memory/index.ts`, so keep it small and do not put project-specific facts there.

To run typecheck and tests:

```bash
cd agent/extensions/personal-memory
npm run typecheck
npm test
```

Manual verification:

1. Run `/remember test-fact` in Pi.
2. Confirm `~/.pi/memory.md` contains the dated bullet.
3. Start a new Pi session in another project.
4. Confirm the memory block appears in agent context.
