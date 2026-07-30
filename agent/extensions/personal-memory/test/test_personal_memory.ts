import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendPersonalMemory, formatPersonalMemoryBlock, normalizeRememberText, readPersonalMemory, resolvePersonalMemoryPath } from "../index.js";
import { formatMemoryIndexBlock, migrateFlatFile, readMemoryEntry, readMemoryIndex, rebuildIndex, resolveMemoryDir, slugify, validateSlug, writeMemoryFact } from "../store.js";

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

{
	const memoryDir = await resolveMemoryDir(path.join(os.tmpdir(), "pi-agent-dir", "agent"));
	assert.equal(memoryDir, path.join(os.tmpdir(), "pi-agent-dir", "memory"));
}

{
	assert.equal(slugify("  Prefer tiny MEMORY!  "), "prefer-tiny-memory");
	assert.equal(validateSlug("prefer-tiny-memory"), "prefer-tiny-memory");
	assert.throws(() => validateSlug("../secret"), /invalid memory slug/);
}

{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-store-"));
	const result = await writeMemoryFact({
		name: "Prefer tiny memory",
		description: "Keep memory small",
		type: "nope",
		body: "Use short durable personal facts.",
	}, dir);
	assert.equal(result.slug, "prefer-tiny-memory");
	const entry = await readMemoryEntry(dir, "prefer-tiny-memory");
	assert.ok(entry);
	assert.match(entry, /name: Prefer tiny memory/);
	assert.match(entry, /type: user/);
	assert.match(entry, /Use short durable personal facts\./);
	const index = await readMemoryIndex(dir);
	assert.ok(index);
	assert.match(index, /\[Prefer tiny memory\]\(prefer-tiny-memory\.md\) — Keep memory small/);
	await assert.rejects(() => writeMemoryFact({ body: "" }, dir), /memory body is required/);
	await assert.rejects(() => readMemoryEntry(dir, "../secret"), /invalid memory slug/);
}

{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-upsert-"));
	await writeMemoryFact({
		name: "Original lesson",
		description: "Original description",
		body: "Original body",
	}, dir);
	const replacement = await writeMemoryFact({
		slug: "original-lesson",
		name: "Improved lesson",
		description: "Improved description",
		body: "Improved body",
	}, dir);
	assert.equal(replacement.slug, "original-lesson");
	assert.equal(path.basename(replacement.path), "original-lesson.md");
	assert.equal(await readMemoryEntry(dir, "improved-lesson"), null);
	const entry = await readMemoryEntry(dir, "original-lesson");
	assert.match(entry ?? "", /name: Improved lesson/);
	assert.match(entry ?? "", /Improved body/);
	const index = await readMemoryIndex(dir);
	assert.match(index ?? "", /\[Improved lesson\]\(original-lesson\.md\) — Improved description/);
	assert.doesNotMatch(index ?? "", /Original description/);
	await assert.rejects(
		() => writeMemoryFact({ slug: "../escape", body: "No traversal" }, dir),
		/invalid memory slug/,
	);
}

{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-concurrent-"));
	await Promise.all([
		writeMemoryFact({ name: "Parallel A", description: "A", body: "A body" }, dir),
		writeMemoryFact({ name: "Parallel B", description: "B", body: "B body" }, dir),
	]);
	const index = await readMemoryIndex(dir);
	assert.match(index ?? "", /\[Parallel A\]\(parallel-a\.md\) — A/);
	assert.match(index ?? "", /\[Parallel B\]\(parallel-b\.md\) — B/);
}

{
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-rebuild-"));
	await writeMemoryFact({ name: "Z fact", description: "Last", type: "project", body: "Z body" }, dir);
	await writeMemoryFact({ name: "A fact", description: "First", type: "reference", body: "A body" }, dir);
	const index = await rebuildIndex(dir);
	assert.match(index, /\[A fact\]\(a-fact\.md\) — First[\s\S]*\[Z fact\]\(z-fact\.md\) — Last/);
	const block = formatMemoryIndexBlock(index);
	assert.ok(block);
	assert.match(block, /personal memory index/i);
	assert.doesNotMatch(block, /A body/);
}

{
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-migrate-"));
	const memoryDir = path.join(root, "memory");
	const legacy = path.join(root, "memory.md");
	const fixture = Array.from({ length: 13 }, (_, i) => `- 2026-06-${String(i + 1).padStart(2, "0")} — fact ${i + 1}`).join("\n");
	await fs.mkdir(memoryDir, { recursive: true });
	await fs.writeFile(path.join(memoryDir, "decisions.md"), "# Legacy decisions\n\n- old retired-system content\n", "utf8");
	await fs.writeFile(legacy, `# Personal memory\n\n${fixture}\n`, "utf8");
	const migrated = await migrateFlatFile(memoryDir, legacy);
	assert.deepEqual(migrated, { migrated: 13, skipped: false });
	assert.equal(await readMemoryEntry(memoryDir, "fact-1") !== null, true);
	const index = await readMemoryIndex(memoryDir);
	assert.equal(index?.split("\n").filter((line) => line.startsWith("- [")).length, 13);
	assert.doesNotMatch(index ?? "", /Legacy decisions/);
	assert.equal(await fs.readFile(path.join(memoryDir, "decisions.md"), "utf8"), "# Legacy decisions\n\n- old retired-system content\n");
	assert.equal(await fs.readFile(path.join(root, "memory.md.bak"), "utf8"), `# Personal memory\n\n${fixture}\n`);
	const skipped = await migrateFlatFile(memoryDir, legacy);
	assert.deepEqual(skipped, { migrated: 0, skipped: true });
}

console.log("test_personal_memory passed!");
