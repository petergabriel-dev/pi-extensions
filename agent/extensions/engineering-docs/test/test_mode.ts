import assert from "node:assert/strict";
import { isDesignWriteAllowed, isWriteAllowed } from "../mode.ts";

assert.equal(isDesignWriteAllowed("design"), true);
assert.equal(isDesignWriteAllowed("build"), true);
assert.equal(isDesignWriteAllowed("off"), true);
assert.equal(isDesignWriteAllowed("discuss"), false);
assert.equal(isDesignWriteAllowed("plan"), false);
assert.equal(isDesignWriteAllowed("review"), false);
assert.equal(isDesignWriteAllowed(undefined), false, "unknown mode must fail closed");
assert.equal(isWriteAllowed("design"), false, "engineering docs stay blocked in design mode");
assert.equal(isWriteAllowed("build"), true);
assert.equal(isWriteAllowed("off"), true);
assert.equal(isWriteAllowed(undefined), false, "unknown engineering mode must fail closed");

console.log("mode assertions passed");
