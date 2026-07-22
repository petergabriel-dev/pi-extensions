// Workflow mode interop via pi.events
// Queries workflow-modes extension for current state and listens for changes.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMode, WorkflowState } from "./constants.js";

let currentWorkflowState: WorkflowState = { mode: "off", hasPlan: false };
let hasReceivedState = false;

export function getWorkflowState(): WorkflowState {
	return currentWorkflowState;
}

export function getMode(): WorkflowMode {
	return currentWorkflowState.mode;
}

export function isWriteAllowed(mode: WorkflowMode | undefined = hasReceivedState ? currentWorkflowState.mode : undefined): boolean {
	return mode === "build" || mode === "off";
}

export function isDesignWriteAllowed(mode: WorkflowMode | undefined = hasReceivedState ? currentWorkflowState.mode : undefined): boolean {
	return mode === "design" || mode === "build" || mode === "off";
}

export function getModeLabel(): string {
	if (!hasReceivedState) return "Unknown";
	const labels: Record<WorkflowMode, string> = {
		off: "OFF",
		discuss: "Discuss",
		plan: "Plan",
		build: "Build",
		review: "Review",
		design: "Design",
	};
	return labels[currentWorkflowState.mode] ?? "Unknown";
}

export function registerModeListeners(pi: ExtensionAPI): void {
	// Listen for mode changes
	pi.events.on("workflow-modes:changed", (data: unknown) => {
		const state = data as { mode?: WorkflowMode; hasPlan?: boolean };
		if (state?.mode) {
			hasReceivedState = true;
			currentWorkflowState = {
				mode: state.mode,
				hasPlan: state.hasPlan ?? false,
			};
		}
	});

	// Query initial state
	pi.events.on("workflow-modes:state", (data: unknown) => {
		const state = data as { mode?: WorkflowMode; hasPlan?: boolean; plan?: string };
		if (state?.mode) {
			hasReceivedState = true;
			currentWorkflowState = {
				mode: state.mode,
				hasPlan: state.hasPlan ?? false,
				plan: state.plan,
			};
		}
	});

	// Request state from workflow-modes
	try {
		pi.events.emit("workflow-modes:get", undefined);
	} catch {
		// Extension not loaded yet or no listener; default to off
	}
}