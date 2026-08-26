import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgents, formatAgentList } from "../agents.ts";
import { READ_ONLY_EXPLORER_TOOLS, validateExplorerTools } from "../index.ts";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agents-"));

assert.equal(validateExplorerTools(["read", "grep", "find", "ls", "browser_goto", "browser_eval", "browser_console", "browser_network", "browser_fill", "browser_click", "browser_screenshot", "browser_close"]), undefined);
assert.equal(READ_ONLY_EXPLORER_TOOLS.has("browser_close"), true);
assert.equal(READ_ONLY_EXPLORER_TOOLS.has("browser_kill"), false);
assert.match(validateExplorerTools(["edit", "write", "bash"]) ?? "", /non-repository-read-only tool\(s\): edit, write, bash/);
assert.match(validateExplorerTools(["browser_kill"]) ?? "", /browser_kill/);

function writeAgent(dir: string, name: string, description = name, tools?: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}${tools ? `\ntools: ${tools}` : ""}\n---\n\nPrompt for ${name}.\n`,
	);
}

try {
	const bundled = path.join(tempRoot, "bundled");
	const user = path.join(tempRoot, "user");
	const projectRoot = path.join(tempRoot, "project");
	const project = path.join(projectRoot, ".pi", "agents");
	fs.mkdirSync(path.join(projectRoot, "nested", "cwd"), { recursive: true });
	writeAgent(bundled, "explorer", "bundled explorer", "read,grep");
	writeAgent(bundled, "worker", "bundled worker");

	const options = { bundledAgentsDir: bundled, userAgentsDir: user };
	const clean = discoverAgents(tempRoot, "user", options);
	assert.deepEqual(clean.agents.map((agent) => agent.name), ["explorer", "worker"]);
	assert.ok(clean.agents.every((agent) => agent.source === "bundled"));

	const packagedDefaults = discoverAgents(tempRoot, "user", {
		userAgentsDir: path.join(tempRoot, "missing-user-agents"),
	});
	assert.deepEqual(packagedDefaults.agents.map((agent) => agent.name), ["explorer", "worker"]);
	assert.ok(packagedDefaults.agents.every((agent) => agent.source === "bundled"));

	writeAgent(user, "user-only", "user definition");
	writeAgent(user, "explorer", "user explorer");
	writeAgent(project, "project-only", "project definition");
	writeAgent(project, "explorer", "project explorer");

	const nestedCwd = path.join(projectRoot, "nested", "cwd");
	const userScoped = discoverAgents(nestedCwd, "user", options);
	assert.equal(userScoped.agents.find((a) => a.name === "explorer")?.source, "user");
	assert.equal(userScoped.agents.some((a) => a.name === "project-only"), false);

	const projectScoped = discoverAgents(nestedCwd, "project", options);
	assert.equal(projectScoped.agents.find((a) => a.name === "explorer")?.source, "project");
	assert.equal(projectScoped.agents.some((a) => a.name === "user-only"), false);

	const both = discoverAgents(nestedCwd, "both", options);
	assert.equal(both.agents.find((a) => a.name === "explorer")?.description, "project explorer");
	assert.equal(both.agents.find((a) => a.name === "user-only")?.source, "user");
	assert.equal(both.agents.find((a) => a.name === "project-only")?.source, "project");
	assert.equal(both.projectAgentsDir, project);

	// Invalid overrides do not displace a bundled default.
	fs.writeFileSync(path.join(user, "worker.md"), "not frontmatter");
	assert.equal(discoverAgents(tempRoot, "user", options).agents.find((a) => a.name === "worker")?.source, "bundled");

	// A valid but unsafe override is selected (the caller's validator rejects it).
	writeAgent(user, "explorer", "unsafe explorer", "read,write");
	const unsafe = discoverAgents(tempRoot, "user", options).agents.find((a) => a.name === "explorer");
	assert.equal(unsafe?.source, "user");
	assert.deepEqual(unsafe?.tools, ["read", "write"]);

	const formatted = formatAgentList(unsafe ? [unsafe] : []);
	assert.match(formatted, /explorer \(user\) model=default tools=read,write - unsafe explorer/);
	assert.equal(formatAgentList([]), "No subagent definitions found.");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("test_agents: ok");
