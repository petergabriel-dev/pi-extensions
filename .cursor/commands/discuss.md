# Pi Discuss

Use this command when discussing ideas in Cursor inside a Pi project.

1. Detect whether cwd or any ancestor contains `.pi/`. If not, use Cursor's normal discussion behavior and do not call Pi bridge tools.
2. In a Pi project, call MCP tool `pi-claude-bridge.recall_memory` first with:
   - `query`: user topic plus known feature/module words
   - `mode`: `discuss`
   - `cwd`: current workspace/cwd if available
3. If recall fails, stop and say exactly:
   > Pi bridge not responding; start/focus Pi in this project.
4. Do not edit files. Cursor is read-only in Pi projects; `.cursor/hooks.json` enforces this with shell/MCP hooks plus after-edit revert.
5. Adopt `prompts.discussPrompt` from the recall result as authoritative mode behavior. Ignore Pi-only tools you do not have; use Cursor read-only discovery only.
6. Mandatory capture checkpoints: after each confirmed decision, answered main question, constraint, preference, open question, or key implementation fact:
   - Say: `Recording this in Pi now.`
   - Call MCP tool `pi-claude-bridge.capture_note` with typed notes.
   - Include `sessionId`: Cursor `conversation_id` when available.
   - Include `context`: short discussion phase summary.
   - If capture fails, stop.
7. Capture note types: `requirement`, `decision`, `constraint`, `question`, `preference`, `implementation`, `lesson`.
8. Handoff: summarize decisions, constraints, NFRs, risks, and open questions; record summary in Pi with `capture_note`; suggest switching to plan when ready.
