# Claude Bridge structural read-only spike

## Conclusion

Claude Code PreToolUse hooks can now return `hookSpecificOutput.updatedInput`, so bridge-side Bash wrapping is feasible for allowed Bash calls. The Pi read-only hook now wraps allowed Bash commands in `/usr/bin/sandbox-exec` on macOS when available, and continues to rely on the widened Pi policy allowlist when no launcher is available.

## Evidence

- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/skills/hook-development/SKILL.md` documents PreToolUse output with `hookSpecificOutput.updatedInput`.
- `~/.claude/cache/changelog.md` records PreToolUse input modification support and native sandbox settings, including sandbox escape controls.
- `agent/claude-bridge-client/pi-readonly-hook.js` now denies `tool_input.dangerouslyDisableSandbox` in Pi projects and returns an allow decision with `updatedInput.command` set to a `sandbox-exec` wrapper when available.
- Manual hook smoke test with a fresh temporary `.pi/memory/bridge/policy.json` returned `permissionDecision: "allow"` plus an updated Bash command beginning with `/usr/bin/sandbox-exec`.

## Remaining fallback

On non-macOS hosts or if `/usr/bin/sandbox-exec` is unavailable, the hook does not fail open: it still enforces the fresh Pi bridge policy allowlist and mutation deny regexes, with mutation tools hard-denied.
