import assert from "node:assert/strict";
import { getModeLabel, isDesignWriteAllowed, isWriteAllowed, registerModeListeners } from "../mode.ts";

assert.equal(isDesignWriteAllowed("build"), true);
assert.equal(isDesignWriteAllowed("off"), true);
assert.equal(isDesignWriteAllowed("discuss"), false);
assert.equal(isDesignWriteAllowed("plan"), false);
assert.equal(isDesignWriteAllowed("review"), false);
assert.equal(isDesignWriteAllowed(undefined), false, "unknown mode must fail closed");
assert.equal(isWriteAllowed("build"), true);
assert.equal(isWriteAllowed("off"), true);
assert.equal(isWriteAllowed("discuss"), false);
assert.equal(isWriteAllowed("plan"), false);
assert.equal(isWriteAllowed("review"), false);
assert.equal(isWriteAllowed(undefined), false, "unknown mode must fail closed");

const listeners = new Map<string, (data: unknown) => void>();
registerModeListeners({
	events: {
		on(name: string, handler: (data: unknown) => void) { listeners.set(name, handler); },
		emit() {},
	},
} as never);
listeners.get("workflow-modes:changed")?.({ mode: "build", hasPlan: false });
assert.equal(isWriteAllowed(), true, "validated Build state enables writes");
listeners.get("workflow-modes:changed")?.({ mode: "design", hasPlan: false });
assert.equal(isDesignWriteAllowed(), false, "legacy state after Build must fail closed");
assert.equal(isWriteAllowed(), false, "legacy state after Build must fail closed");
assert.equal(getModeLabel(), "Unknown", "legacy state must be labeled unknown");

console.log("mode assertions passed");
