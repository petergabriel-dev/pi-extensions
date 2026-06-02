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
- Claude Code read-only Bash such as `rg` is allowed only with fresh bridge policy.
- On macOS with `/usr/bin/sandbox-exec`, Claude Code allowed Bash is rewritten through the read-only sandbox hook; inspect hook output with `--include-hook-events` or direct hook smoke tests when debugging.

No-commit note: this `~/.pi` workspace may not be a Git repo. Build checkpoints can be explicit no-commit checkpoints when approved by the user.

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

## Persistent-Memory Extension testing

To run typecheck and tests in the persistent-memory extension directory:

```bash
cd agent/extensions/persistent-memory
npm run typecheck
npm test
```

This runs the typechecker (`tsc --noEmit`) and executes the four standalone TS unit test suites under `test/` using `tsx`:
- `test_classifier.ts`: Tests reason-aware classification of session transitions.
- `test_reason_matrix.ts`: Tests mapped lifecycle actions for different transition reasons.
- `test_generation_swap.ts`: Tests background task lifecycle generation swap logic.
- `test_firing_log.ts`: Tests firing log logging and preservation across reload transitions.
