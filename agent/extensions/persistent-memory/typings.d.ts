declare module "@mariozechner/pi-agent-core" {
	export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

declare module "@mariozechner/pi-coding-agent" {
	export interface ExtensionAPI {
		on(event: string, callback: (...args: any[]) => any): void;
		registerCommand(name: string, config: any): void;
		registerTool(config: any): void;
		appendEntry(key: string, data: any): void;
		ui: {
			// Host-level pi.ui is acceptable for notify/confirm only. TUI surfaces
			// such as setStatus/setWidget belong to ctx.ui and must be gated by ctx.hasUI.
			notify(message: string, type: "info" | "warning" | "error" | "success"): void;
			confirm(title: string, message: string): Promise<boolean>;
			[key: string]: any;
		};
	}

	export interface ExtensionCommandContext {
		cwd: string;
		ui: any;
		[key: string]: any;
	}

	export type ExtensionContext = any;
	export type ToolResultEvent = any;
	export const DEFAULT_MAX_BYTES: any;
	export const DEFAULT_MAX_LINES: any;
	export function formatSize(bytes: number): string;
	export function truncateTail(
		text: string,
		options: { maxLines: any; maxBytes: any }
	): {
		truncated: boolean;
		content: string;
		outputBytes: number;
		totalBytes: number;
	};

	export class AuthStorage {
		static create(...args: any[]): any;
	}
	export class DefaultResourceLoader {
		constructor(...args: any[]);
		reload(...args: any[]): any;
		getExtensions(...args: any[]): any;
		getSkills(...args: any[]): any;
		getPrompts(...args: any[]): any;
		getAgentsFiles(...args: any[]): any;
	}
	export class SessionManager {
		static inMemory(...args: any[]): any;
	}
	export class SettingsManager {
		static inMemory(...args: any[]): any;
	}
	export function createAgentSession(...args: any[]): any;
	export function getAgentDir(...args: any[]): any;
	export class ModelRegistry {
		static create(...args: any[]): any;
		getAll(): any[];
		hasConfiguredAuth(model: any): boolean;
	}
}

declare module "@mariozechner/pi-ai" {
	export interface Model<T> {
		id: string;
		provider: string;
		name: string;
	}
	export function StringEnum(values: readonly string[], options?: any): any;
}

declare module "typebox" {
	export const Type: any;
}

declare module "js-yaml" {
	const jsYaml: any;
	export default jsYaml;
	export function load(text: string, options?: any): any;
	export const JSON_SCHEMA: any;
}

declare module "better-sqlite3" {
	const betterSqlite3: any;
	export default betterSqlite3;
}
