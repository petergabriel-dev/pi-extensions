---
name: pi-discuss
description: Pi Discuss workflow for Codex. Use ONLY when the user explicitly invokes $pi-discuss; never trigger implicitly.
---

# $pi-discuss — Codex Pi Discuss

Use this skill to discuss ideas with Pi context when the project is a Pi project.

## Detect project

Check whether the current working directory or any ancestor contains `.pi/`. Pi's global agent dir `~/.pi` does not mark a project.

- Outside a Pi project: use the non-Pi fallback below; do not call Pi bridge tools.
- Inside a Pi project: use the bridge workflow below.

## Codex bridge calls

Pi bridge tools are on the `pi-claude-bridge` MCP server. The Pi Codex hook injects `sessionId` and `harness` from Codex's host session; never supply a session ID or `claudeSessionId`. Pass `harness: "codex"` or omit it. Pass `cwd` only when you know the current project path.

Codex reads files through shell. Without a Build lease the Pi hook allows only provably read-only commands (`rg`, `cat`, `head`, `tail`, `ls`, `find`, `wc`, `git status|log|show|diff|blame`, simple pipes). Avoid `$(...)`, backticks, redirects, and unquoted globs; quote patterns instead.

## Pi-project discussion

1. Call `recall_memory` with:
   - `query`: the user's topic plus known feature/module words
   - `mode`: `discuss`
2. If the bridge call fails or returns `ok: false`, stop. Quote the exact refusal; if unavailable, say exactly:
   > Pi bridge not responding; start/focus Pi in this project.
3. Adopt returned `prompts.discussPrompt` as authoritative discussion behavior, including its ponytail reflex. Ignore tools it names that you do not have. Use read-only tools only; do not edit files or run tests/builds unless the user asks.
4. Ask one main question at a time with Codex's question tool (`request_user_input`, or `request_user_input_async` in the desktop app) when available; otherwise say no question tool exists, then ask in prose. Give a recommended answer with tradeoffs; separate goals from requirements.
5. After each confirmed decision, answered main question, constraint, preference, open question, or important implementation fact, say `Recording this in Pi now.` and call `capture_note` with typed notes and `context`. Types: `requirement`, `decision`, `constraint`, `action`, `question`, `preference`, `implementation`, `lesson` (a lesson pairs a failure with its resolution). If capture fails, stop.
6. Handoff by summarizing decisions, constraints, NFRs, risks, and open questions; capture the final summary; suggest `$pi-plan` when ready.

Do not run `$pi-discuss` while this Codex session holds a Pi Build lease: a Discuss recall releases the lease.

## Non-Pi fallback

Ask what the user wants to discuss and which area it touches. Read `specs/ARCHITECTURE.md`, `specs/FEATURES.md`, and relevant `specs/shadow/*.shadow.md` files when present. Use read-only search for grounding, then ask one focused question at a time. Offer `$pi-plan` or an implementation handoff when useful. Do not use Pi bridge tools.
