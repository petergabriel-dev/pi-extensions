import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendPersonalMemory, formatPersonalMemoryBlock, normalizeRememberText, readPersonalMemory, resolvePersonalMemoryPath } from "../index.js";

console.log("Running test_personal_memory...");

{
	assert.equal(normalizeRememberText("  keep   this\nsmall  "), "keep this small");
	assert.equal(normalizeRememberText("   "), null);
	assert.equal(normalizeRememberText(42), null);
}

{
	const memoryPath = await resolvePersonalMemoryPath(path.join(os.tmpdir(), "pi-agent-dir", "agent"));
	assert.equal(memoryPath, path.join(os.tmpdir(), "pi-agent-dir", "memory.md"));
}

{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-"));
	const memoryPath = path.join(dir, "memory.md");
	assert.equal(await readPersonalMemory(memoryPath), null);
	await appendPersonalMemory(memoryPath, "prefer tiny memory", new Date("2026-06-29T12:00:00.000Z"));
	await appendPersonalMemory(memoryPath, "avoid model extraction", new Date("2026-06-30T12:00:00.000Z"));
	const memory = await readPersonalMemory(memoryPath);
	assert.ok(memory);
	assert.match(memory, /^# Personal memory/);
	assert.match(memory, /- 2026-06-29 — prefer tiny memory/);
	assert.match(memory, /- 2026-06-30 — avoid model extraction/);
}

{
	const block = formatPersonalMemoryBlock("- 2026-06-29 — test fact");
	assert.match(block, /# User-global personal memory/);
	assert.match(block, /~\/\.pi\/memory\.md/);
	assert.match(block, /test fact/);
}

console.log("test_personal_memory passed!");
