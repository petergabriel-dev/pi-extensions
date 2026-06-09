import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractLastAssistantText, extractSubmitPlanToolArguments, SUBMIT_PLAN_TOOL_NAME } from "../consolidation/careful-model.js";
import { runReconciliation } from "../consolidation/reconcile.js";
import { writeStaging } from "../consolidation/staging.js";
import { parseDomainFile } from "../storage/markdown.js";
import type { StagingFile } from "../types.js";

console.log("Running test_reconcile_response_paths...");

type DomainCandidate = StagingFile["candidates"]["domain"][number];

function setup(sessionId = "s1", candidate: DomainCandidate = domainCandidate()) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-reconcile-paths-"));
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
		candidates: { lessons: [], preferences: [], decisions: [], domain: [candidate] },
	});
	return { root, mem };
}

function domainCandidate(): DomainCandidate {
	return {
		summary: "persistent-memory consolidation path",
		detail: "model response path should be deterministic and local",
		source_evidence: { discussion_note_ids: [1] },
	};
}

function addDomainPlan(ref = "s1:domain:1", detail = "merged detail") {
	return {
		lessons: [],
		preferences: [],
		decisions: [],
		domain: [{ action: "add", candidate_refs: [ref], summary: "merged summary", detail }],
	};
}

async function reconcileWithRawResponse(rawResponse: string) {
	const { root, mem } = setup();
	const result = await runReconciliation({ projectRoot: root, projectMemoryDir: mem, globalMemoryDir: mem }, {} as any, {
		chunkSize: 1,
		rebuildIndex: () => undefined,
		callCarefulModel: async () => rawResponse,
	});
	assert.equal(result.status, "completed");
	const facts = parseDomainFile(path.join(mem, "domain.md"));
	assert.equal(facts.length, 1);
	return facts[0];
}

async function testForcedSubmitPlanToolArgumentsFeedReconciliation() {
	const toolJson = extractSubmitPlanToolArguments({
		role: "assistant",
		content: [
			{ type: "text", text: "ignored narrative" },
			{ type: "toolCall", id: "call_1", name: SUBMIT_PLAN_TOOL_NAME, arguments: addDomainPlan() },
		],
	} as never);
	assert.ok(toolJson);
	const fact = await reconcileWithRawResponse(toolJson);
	assert.equal(fact.summary, "merged summary");
}

async function testThinkingOnlyAssistantTextCanFeedReconciliation() {
	const rawPlan = JSON.stringify(addDomainPlan("s1:domain:1", "from thinking-only salvage"));
	const salvaged = extractLastAssistantText({
		getLastAssistantText: () => "",
		messages: [{ role: "assistant", content: [{ type: "thinking", thinking: { content: rawPlan } }] }],
	} as never);
	assert.equal(salvaged, rawPlan);
	const fact = await reconcileWithRawResponse(salvaged);
	assert.equal(fact.detail, "from thinking-only salvage");
}

async function testTolerantParsePreventsParseErrorForRepairableReconciliationJson() {
	const rawWithUnescapedNewline =
		'{"lessons":[],"preferences":[],"decisions":[],"domain":[{"action":"add","candidate_refs":["s1:domain:1"],"summary":"merged summary","detail":"line one\nline two"}]}';
	const fact = await reconcileWithRawResponse(rawWithUnescapedNewline);
	assert.equal(fact.detail, "line one\nline two");
}

async function main() {
	await testForcedSubmitPlanToolArgumentsFeedReconciliation();
	await testThinkingOnlyAssistantTextCanFeedReconciliation();
	await testTolerantParsePreventsParseErrorForRepairableReconciliationJson();
	console.log("test_reconcile_response_paths passed!");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
