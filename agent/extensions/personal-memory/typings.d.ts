declare module "node:fs/promises" {
	export function readFile(path: string, encoding: string): Promise<string>;
	export function appendFile(path: string, data: string, encoding: string): Promise<void>;
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	export function stat(path: string): Promise<{ size: number }>;
	export function mkdtemp(prefix: string): Promise<string>;
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
	export function dirname(path: string): string;
	export function basename(path: string): string;
}

declare module "node:assert" {
	const assert: any;
	export default assert;
}

declare module "@earendil-works/pi-coding-agent" {
	export function getAgentDir(): string;
}

declare module "@mariozechner/pi-coding-agent" {
	export interface ExtensionAPI {
		on(event: string, callback: (...args: any[]) => any): void;
		registerCommand(name: string, config: any): void;
		registerTool?(config: any): void;
	}

	export interface ExtensionCommandContext {
		cwd: string;
		ui: { notify(message: string, type: "info" | "warning" | "error" | "success"): void };
		[key: string]: any;
	}

	export function getAgentDir(): string;
}
