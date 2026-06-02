export type SandboxLauncher = "none";

export interface SandboxWrapOptions {
	cwd: string;
	scratchDir?: string;
}

export interface SandboxWrapResult {
	launcher: SandboxLauncher;
	command: string;
	wrapped: boolean;
}

/**
 * Placeholder launcher detection for the workflow-modes sandbox module.
 * Task 2 replaces this with real platform/launcher detection.
 */
export function detectLauncher(): SandboxLauncher {
	return "none";
}

/**
 * Placeholder command wrapper for the workflow-modes sandbox module.
 * With no launcher available, the command is returned unchanged.
 */
export function wrapCommand(command: string, _options: SandboxWrapOptions): SandboxWrapResult {
	return {
		launcher: "none",
		command,
		wrapped: false,
	};
}
