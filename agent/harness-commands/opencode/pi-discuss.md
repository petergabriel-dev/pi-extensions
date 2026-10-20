# /pi-discuss — OpenCode Pi Discuss

Use this command to discuss ideas with Pi context when the project is a Pi project.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`.

- Outside a Pi project: use the non-Pi fallback below; do not call Pi bridge tools.
- Inside a Pi project: use the bridge workflow below.

## OpenCode Code Mode bridge calls

MCP tools are exposed through Code Mode `execute`. Before each bridge call, run synchronous `search({ query: "<tool name>", namespace: "pi-claude-bridge" })`, then call the exact path returned. Do not await `search` or call a bridge MCP tool directly. Example path: `tools["pi-claude-bridge"].recall_memory(...)`.

The plugin overwrites `sessionId` and `harness` from OpenCode's host `sessionID`. Never supply a model-invented session ID or `claudeSessionId`; use `harness: "opencode"` for bridge calls. Pass `cwd` only when OpenCode explicitly provides the current project path; otherwise rely on the configured MCP server cwd.

## Pi-project discussion

1. Call `recall_memory` with:
   - `query`: the user's topic plus known feature/module words
   - `mode`: `discuss`
   - `harness`: `"opencode"`
2. If the bridge call fails or returns `ok: false`, stop. Quote the exact refusal; if unavailable, say exactly:
   > Pi bridge not responding; start/focus Pi in this project.
3. Adopt returned `prompts.discussPrompt` as authoritative discussion behavior, including its ponytail reflex. Use read-only tools only; do not edit files or run tests/builds unless the user asks.
4. Ask one main question at a time. Give a recommended answer with tradeoffs; separate goals from requirements.
5. After each confirmed decision, answered main question, constraint, preference, open question, or important implementation fact, say `Recording this in Pi now.` and capture a typed `capture_note` through Code Mode. Include `context`, `harness: "opencode"`, and the relevant note type/text. Types: `requirement`, `decision`, `constraint`, `action`, `question`, `preference`, `implementation`, `lesson`. If capture fails, stop.
6. Handoff by summarizing decisions, constraints, NFRs, risks, and open questions; capture the final summary; suggest `/pi-plan` when ready.

## Non-Pi fallback

Ask what the user wants to discuss and which area it touches. Read `specs/ARCHITECTURE.md`, `specs/FEATURES.md`, and relevant `specs/shadow/*.shadow.md` files when present. Use read-only search/grep for grounding, then ask one focused question at a time. Offer `/spec`, `/pi-plan`, `/bug-report`, `/bug-fix`, or an implementation handoff when useful. Do not use Pi bridge tools.
