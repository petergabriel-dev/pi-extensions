import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePlanTasks } from "../plan-tasks.js";

console.log("Running test_plan_tasks...");

const template = await readFile(new URL("../plan-template.md", import.meta.url), "utf8");
assert.deepEqual(parsePlanTasks(template), [], "template code examples must not become tasks");
assert.deepEqual(parsePlanTasks("# No tasks\n\n## Section 5 — Definition of Done\n- [ ] Not a build task\n"), [], "missing Section 4 must be empty");

const handEdited = `# Hand-edited plan

## Section 4 - Tasks

- [ ] First task
  - **Given** input exists **When** parser runs **Then** task is returned
  - **NFRs:** bounded output
  - **Verification Gate:** focused test passes
  - **Checkpoint:** commit task
- [x] Already done
- [ ] Second task without metadata

## Section 5 — Definition of Done
- [ ] Must not be parsed
`;
const parsed = parsePlanTasks(handEdited);
assert.equal(parsed.length, 2);
assert.equal(parsed[0]?.title, "First task");
assert.deepEqual(parsed[0]?.metadata, {
	given: "input exists",
	when: "parser runs",
	then: "task is returned",
	nfrs: "bounded output",
	verificationGate: "focused test passes",
	checkpoint: "commit task",
});
assert.deepEqual(parsed[1]?.metadata, {});
assert.deepEqual(parsePlanTasks(handEdited), parsed, "ids must be deterministic");
assert.notEqual(parsed[0]?.id, parsed[1]?.id);
assert.deepEqual(parsePlanTasks(null as unknown as string), [], "malformed input must not throw");

console.log(`test_plan_tasks passed (${parsed.length} tasks)`);
