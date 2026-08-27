import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentRole = "explorer" | "worker";
export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: AgentRole | string;
	description: string;
	tools?: string[];
	model?: string;
	subagentAgents?: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	userAgentsDir: string;
	projectAgentsDir: string | null;
	agentScope: AgentScope;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	subagent_agents?: unknown;
};

export const DEFAULT_AGENT_SCOPE: AgentScope = "user";

const BUNDLED_AGENTS_DIR = fileURLToPath(new URL("../../agents", import.meta.url));

export interface AgentDiscoveryOptions {
	/** Test seam for supplying isolated definition directories. */
	bundledAgentsDir?: string;
	userAgentsDir?: string;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTools(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const tools = value
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}
	if (Array.isArray(value)) {
		const tools = value.map((tool) => asString(tool)).filter((tool): tool is string => Boolean(tool));
		return tools.length > 0 ? tools : undefined;
	}
	return undefined;
}

function parseAgentNames(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const names = value.split(",").map((name) => asString(name)).filter((name): name is string => Boolean(name));
		return names.length > 0 ? [...new Set(names)] : undefined;
	}
	if (Array.isArray(value)) {
		const names = value.map((name) => asString(name)).filter((name): name is string => Boolean(name));
		return names.length > 0 ? [...new Set(names)] : undefined;
	}
	return undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		const name = asString(frontmatter.name);
		const description = asString(frontmatter.description);
		if (!name || !description) continue;

		agents.push({
			name,
			description,
			tools: parseTools(frontmatter.tools),
			model: asString(frontmatter.model),
			subagentAgents: parseAgentNames(frontmatter.subagent_agents),
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	agentScope: AgentScope = DEFAULT_AGENT_SCOPE,
	options: AgentDiscoveryOptions = {},
): AgentDiscoveryResult {
	const bundledAgentsDir = options.bundledAgentsDir ?? BUNDLED_AGENTS_DIR;
	const userAgentsDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundledAgents = loadAgentsFromDir(bundledAgentsDir, "bundled");
	const userAgents = agentScope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
	const projectAgents = agentScope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const byName = new Map<string, AgentConfig>();

	for (const agent of bundledAgents) byName.set(agent.name, agent);
	if (agentScope === "user" || agentScope === "both") {
		for (const agent of userAgents) byName.set(agent.name, agent);
	}
	if (agentScope === "project" || agentScope === "both") {
		for (const agent of projectAgents) byName.set(agent.name, agent);
	}

	return {
		agents: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		userAgentsDir,
		projectAgentsDir,
		agentScope,
	};
}

export function formatAgentList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "No subagent definitions found.";
	return agents
		.map((agent) => {
			const tools = agent.tools?.join(",") ?? "default";
			const model = agent.model ?? "default";
			const subagents = agent.subagentAgents?.join(",") ?? "none";
			return `${agent.name} (${agent.source}) model=${model} tools=${tools} subagent_agents=${subagents} - ${agent.description}`;
		})
		.join("\n");
}
