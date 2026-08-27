#!/usr/bin/env node

const fs = require("node:fs");
const { execFile } = require("node:child_process");

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CWD_LENGTH = 4096;
const MAX_STAGED_OUTPUT_BYTES = 256 * 1024;
const MAX_STAGED_FILES = 4096;
const MAX_PATH_LENGTH = 4096;
const GIT_ARGS = ["diff", "--cached", "--name-only", "-z"];

function allow() {
	return { permission: "allow" };
}

function ask(docPath) {
	const message = `Staged changes omit docs/engineering/**. Review ${docPath} before committing.`;
	return { permission: "ask", user_message: message, agent_message: message };
}

function readStdinJson() {
	const raw = fs.readFileSync(0, "utf8");
	if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) throw new Error("hook input too large");
	if (!raw.trim()) return {};
	const input = JSON.parse(raw);
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hook input must be a JSON object");
	return input;
}

function firstString(...values) {
	return values.find((value) => typeof value === "string")?.trim() || "";
}

function commandFromInput(input) {
	return firstString(
		input.command,
		input.shell_command,
		input.shellCommand,
		input.tool_input?.command,
		input.toolInput?.command,
	);
}

function hookCwd(input) {
	const cwd = firstString(input.cwd, input.workspaceRoot, input.workspace_root, input.projectRoot, input.project_root);
	if (!cwd) return process.cwd();
	if (cwd.length > MAX_CWD_LENGTH) throw new Error("hook cwd too long");
	return cwd;
}

function isGitCommit(command) {
	return /(^|(?:&&|\|\||;))\s*git\s+commit(?:\s|$)/.test(command);
}

function parseStagedPaths(stdout) {
	if (typeof stdout !== "string") throw new Error("git returned non-text staged paths");
	if (Buffer.byteLength(stdout, "utf8") > MAX_STAGED_OUTPUT_BYTES) throw new Error("staged path list too large");
	const paths = stdout.split("\0").filter(Boolean);
	if (paths.length > MAX_STAGED_FILES) throw new Error("too many staged paths");
	for (const filePath of paths) {
		if (filePath.length > MAX_PATH_LENGTH) throw new Error("staged path too long");
	}
	return paths;
}

function stagedPaths(cwd, execFileImpl) {
	return new Promise((resolve, reject) => {
		execFileImpl("git", GIT_ARGS, { cwd, encoding: "utf8", maxBuffer: MAX_STAGED_OUTPUT_BYTES }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			try {
				resolve(parseStagedPaths(stdout));
			} catch (parseError) {
				reject(parseError);
			}
		});
	});
}

function hasEngineeringDocs(paths) {
	return paths.some((filePath) => filePath.replaceAll("\\", "/").startsWith("docs/engineering/"));
}

function likelyDoc(paths) {
	if (paths.some((filePath) => filePath.startsWith("agent/") || filePath.startsWith(".cursor/"))) {
		return "docs/engineering/architecture.md";
	}
	return "docs/engineering/dev-workflow.md";
}

async function handle(input, execFileImpl = execFile) {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) return allow();
		if (!isGitCommit(commandFromInput(input))) return allow();
		const paths = await stagedPaths(hookCwd(input), execFileImpl);
		if (paths.length === 0 || hasEngineeringDocs(paths)) return allow();
		return ask(likelyDoc(paths));
	} catch {
		return allow();
	}
}

async function main() {
	try {
		console.log(JSON.stringify(await handle(readStdinJson())));
	} catch {
		console.log(JSON.stringify(allow()));
	}
}

if (require.main === module) main();

module.exports = { GIT_ARGS, handle, isGitCommit, parseStagedPaths, likelyDoc };
