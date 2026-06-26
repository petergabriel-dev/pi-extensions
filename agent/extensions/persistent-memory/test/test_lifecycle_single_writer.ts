import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import persistentMemory from "../index.js";
import { logFiring, getSessionFiringLog, clearFiringLog } from "../retrieval/firing-log.js";
import { serializeLessonsFile } from "../storage/markdown.js";
import { writeStaging } from "../consolidation/staging.js";
import type { Lesson, StagingFile } from "../types.js";

console.log("Running test_lifecycle_single_writer...");

function lesson(): Lesson {
	return {
		id: "lsn_01",
		summary: "Existing lesson",
		detail: "Existing detail.",
		meta: {
			project_scope: path.basename(process.cwd()),
			status: "active",
			session_level: false,
			reinforcement_count: 0,
			last_seen_at: null,
			source_session: "s0",
			created_at: "2026-01-01T00:00:00.000Z",
			supersedes: null,
			triggers: [{ type: "topic", value: "testing" }],
		},
	};
}

function canonicalSnapshot(mem: string): Record<string, string> {
	return Object.fromEntries(["lessons.md", "preferences.md", "decisions.md", "domain.md"].map((name) => [name, fs.readFileSync(path.join(mem, name), "utf8")]));
}

function assertCanonicalUnchanged(mem: string, before: Record<string, string>) {
	assert.deepEqual(canonicalSnapshot(mem), before);
}

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-lifecycle-single-writer-"));
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	fs.writeFileSync(path.join(mem, "lessons.md"), serializeLessonsFile([lesson()]), "utf8");
	fs.writeFileSync(path.join(mem, "preferences.md"), "", "utf8");
	fs.writeFileSync(path.join(mem, "decisions.md"), "", "utf8");
	fs.writeFileSync(path.join(mem, "domain.md"), "", "utf8");
	writeStaging(path.join(mem, "staging", "s1.json"), {
		schemaVersion: 1,
		session_id: "s1",
		produced_at: "2026-06-10T00:00:00.000Z",
		project_root: root,
		candidates: {
			lessons: [{ summary: "New deterministic lesson", detail: "No collision here.", scope_suggestion: path.basename(root), triggers: [{ type: "topic", value: "unique" }], source_evidence: { discussion_note_ids: [1] } }],
			preferences: [],
			decisions: [],
			domain: [],
		},
	} satisfies StagingFile);

	const before = canonicalSnapshot(mem);
	const handlers = new Map<string, Function>();
	const pi = {
		on: (name: string, handler: Function) => { handlers.set(name, handler); },
		registerCommand: () => undefined,
		appendEntry: () => undefined,
		ui: {},
	} as any;
	persistentMemory(pi);

	const ctx = {
		cwd: root,
		hasUI: true,
		ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
		sessionManager: { getSessionId: () => "s1", getBranch: () => [{ role: "user", content: "remember important thing" }] },
	};

	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assertCanonicalUnchanged(mem, before);

	logFiring({
		lesson_id: "lsn_01",
		trigger: { type: "topic", value: "testing" },
		fired_at: "2026-06-10T00:00:00.000Z",
		context_summary: "test",
		tier: 1,
	});
	await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	assertCanonicalUnchanged(mem, before);
	assert.equal(getSessionFiringLog().length, 1, "shutdown must not clear firing telemetry");
	clearFiringLog();
	fs.rmSync(root, { recursive: true, force: true });
	console.log("test_lifecycle_single_writer passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
