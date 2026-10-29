// Workflow mode interop via pi.events
// Queries workflow-modes extension for current state and listens for changes.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMode, WorkflowState } from "./constants.js";

let currentWorkflowState: WorkflowState = { mode: "off", hasPlan: false };
let hasReceivedState = false;

export function getWorkflowState(): WorkflowState {
	return currentWorkflowState;
}

export function getMode(): WorkflowMode | undefined {
	return currentWorkflowState.mode;
}

export function isWriteAllowed(mode: WorkflowMode | undefined = hasReceivedState ? currentWorkflowState.mode : undefined): boolean {
	return mode === "build" || mode === "off";
}

export function isDesignWriteAllowed(mode: WorkflowMode | undefined = hasReceivedState ? currentWorkflowState.mode : undefined): boolean {
	return isWriteAllowed(mode);
}

export function getModeLabel(): string {
	if (!hasReceivedState || currentWorkflowState.mode === undefined) return "Unknown";
	const labels: Record<WorkflowMode, string> = {
		off: "OFF",
		discuss: "Discuss",
		plan: "Plan",
		build: "Build",
		review: "Review",
	};
	return labels[currentWorkflowState.mode] ?? "Unknown";
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
	return value === "off" || value === "discuss" || value === "plan" || value === "build" || value === "review";
}

function applyWorkflowState(data: unknown): void {
	const state = data && typeof data === "object" ? data as { mode?: unknown; hasPlan?: boolean; plan?: string } : {};
	if (!isWorkflowMode(state.mode)) {
		hasReceivedState = false;
		currentWorkflowState = { mode: undefined, hasPlan: false };
		return;
	}
	hasReceivedState = true;
	currentWorkflowState = {
		mode: state.mode,
		hasPlan: state.hasPlan ?? false,
		plan: state.plan,
	};
}

export function registerModeListeners(pi: ExtensionAPI): void {
	// Listen for mode changes
	pi.events.on("workflow-modes:changed", applyWorkflowState);

	// Query initial state
	pi.events.on("workflow-modes:state", applyWorkflowState);

	// Request state from workflow-modes
	try {
		pi.events.emit("workflow-modes:get", undefined);
	} catch {
		// Extension not loaded yet or no listener; default to off
	}
}