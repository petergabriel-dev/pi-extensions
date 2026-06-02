import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReconciliation } from "../consolidation/reconcile.js";
import { listDeadLetterFiles, listStagingFiles, readStaging, writeStaging } from "../consolidation/staging.js";
import { parseDomainFile } from "../storage/markdown.js";
import type { StagingFile } from "../types.js";

console.log("Running test_chunked_reconcile...");

type DomainCandidate = StagingFile["candidates"]["domain"][number];

function domainCandidate(n: number, attempts?: number): DomainCandidate {
	return {
		summary: `D${n}`,
		detail: `detail ${n}`,
		source_evidence: { discussion_note_ids: [n] },
		...(attempts === undefined ? {} : { reconcile_attempts: attempts }),
	};
}

function setup(sessionId: string, candidates: DomainCandidate[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-chunked-"));
	const mem = path.join(root, ".pi", "memory");
	fs.mkdirSync(path.join(mem, "staging"), { recursive: true });
	for (const name of ["lessons.md", "preferences.md", "decisions.md", "domain.md"]) {
		fs.writeFileSync(path.join(mem, name), "", "utf8");
	}
	writeStaging(path.join(mem, "staging", `${sessionId}.json`), {
		schemaVersion: 1,
		session_id: sessionId,
		produced_at: "2026-01-01T00:00:00.000Z",
		project_root: root,
		candidates: { lessons: [], preferences: [], decisions: [], domain: candidates },
	});
	return { root, mem };
}

function refs(userPrompt: string, sessionId = "s1"): string[] {
	return [...new Set([...userPrompt.matchAll(new RegExp(`${sessionId}:domain:\\d+`, "g"))].map((m) => m[0]))];
}

function addResponse(candidateRefs: string[], summary = "merged domain", detail = "merged detail"): string {
	return JSON.stringify({
		lessons: [],
		preferences: [],
		decisions: [],
		domain: [{ action: "add", candidate_refs: candidateRefs, summary, detail }],
	});
}

function stagingDomain(mem: string): DomainCandidate[] {
	return listStagingFiles(mem).flatMap((file) => readStaging(file)?.candidates.domain ?? []);
}

function conservationCount(mem: string): number {
	return parseDomainFile(path.join(mem, "domain.md")).length + stagingDomain(mem).length + listDeadLetterFiles(mem).length;
}

async function testChunkSlicingOrderAndCrossChunkMerge() {
	const { root, mem } = setup("s1", [1, 2, 3, 4, 5].map((n) => domainCandidate(n)));
	const calls: string[][] = [];
	let callNo = 0;
	const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, {} as any, {
		chunkSize: 2,
		rebuildIndex: () => undefined,
		callCarefulModel: async (_system, userPrompt) => {
			callNo += 1;
			const candidateRefs = refs(userPrompt);
			calls.push(candidateRefs);
			const actions = callNo === 1
				? [{ action: "add", candidate_refs: candidateRefs, summary: "merged", detail: "first" }]
				: [{ action: "merge", candidate_refs: candidateRefs, target_id: "dom_01", summary: "merged", detail: `call ${callNo}` }];
			return JSON.stringify({ lessons: [], preferences: [], decisions: [], domain: actions });
		},
	});
	assert.equal(result.status, "completed");
	assert.deepEqual(calls, [["s1:domain:1", "s1:domain:2"], ["s1:domain:3", "s1:domain:4"], ["s1:domain:5"]]);
	assert.ok(calls.every((call) => call.length <= 2));
	assert.equal(parseDomainFile(path.join(mem, "domain.md")).length, 1);
	assert.equal(stagingDomain(mem).length, 0);
	assert.equal(conservationCount(mem), 1);
}

async function testPerChunkPartialFallback() {
	const { root, mem } = setup("s1", [domainCandidate(1), domainCandidate(2)]);
	const partial = JSON.stringify({ lessons: [], preferences: [], decisions: [], domain: [{ action: "add", candidate_refs: ["s1:domain:1"], summary: "one", detail: "one" }] });
	const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, {} as any, {
		chunkSize: 2,
		rebuildIndex: () => undefined,
		callCarefulModel: async () => partial,
	});
	assert.equal(result.status, "completed");
	assert.equal(parseDomainFile(path.join(mem, "domain.md")).length, 1);
	assert.deepEqual(stagingDomain(mem).map((c) => c.reconcile_attempts), [1]);
	assert.equal(conservationCount(mem), 2);
}

async function testBudgetCutoffAttemptsUnchanged() {
	const { root, mem } = setup("s1", [domainCandidate(1, 6), domainCandidate(2, 7), domainCandidate(3, 8)]);
	let nowCalls = 0;
	const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, {} as any, {
		chunkSize: 1,
		wallClockBudgetMs: 5,
		nowMs: () => (nowCalls++ === 0 ? 0 : 10),
		rebuildIndex: () => undefined,
		callCarefulModel: async (_system, userPrompt) => addResponse(refs(userPrompt)),
	});
	assert.equal(result.status, "completed");
	assert.deepEqual(stagingDomain(mem).map((c) => c.reconcile_attempts), [7, 8]);
	assert.equal(conservationCount(mem), 3);
}

async function testModelErrorChunkAttemptsUnchanged() {
	const { root, mem } = setup("s1", [domainCandidate(1, 1), domainCandidate(2, 2), domainCandidate(3, 3)]);
	let callNo = 0;
	const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, {} as any, {
		chunkSize: 1,
		rebuildIndex: () => undefined,
		callCarefulModel: async (_system, userPrompt) => {
			callNo += 1;
			if (callNo === 2) throw new Error("simulated timeout");
			return addResponse(refs(userPrompt));
		},
	});
	assert.equal(result.status, "failed");
	if (result.status !== "failed") throw new Error("expected failed reconciliation");
	assert.equal(result.reason, "model_error");
	assert.deepEqual(stagingDomain(mem).map((c) => c.reconcile_attempts), [2, 3]);
	assert.equal(conservationCount(mem), 3);
}

async function testDeadLetterOnlyAfterValidationCap() {
	const previous = process.env.PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS;
	process.env.PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS = "1";
	try {
		const { root, mem } = setup("s1", [domainCandidate(1, 1)]);
		const emptyInvalid = JSON.stringify({ lessons: [], preferences: [], decisions: [], domain: [] });
		const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, {} as any, {
			chunkSize: 1,
			rebuildIndex: () => undefined,
			callCarefulModel: async () => emptyInvalid,
		});
		assert.equal(result.status, "failed");
		if (result.status !== "failed") throw new Error("expected failed reconciliation");
		assert.equal(result.reason, "invalid_model_response");
		assert.equal(stagingDomain(mem).length, 0);
		assert.equal(listDeadLetterFiles(mem).length, 1);
		assert.equal(conservationCount(mem), 1);
	} finally {
		if (previous === undefined) delete process.env.PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS;
		else process.env.PERSISTENT_MEMORY_RECONCILIATION_MAX_ATTEMPTS = previous;
	}
}

async function main() {
	await testChunkSlicingOrderAndCrossChunkMerge();
	await testPerChunkPartialFallback();
	await testBudgetCutoffAttemptsUnchanged();
	await testModelErrorChunkAttemptsUnchanged();
	await testDeadLetterOnlyAfterValidationCap();
	console.log("test_chunked_reconcile passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
