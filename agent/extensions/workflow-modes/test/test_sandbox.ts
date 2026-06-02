import assert from "node:assert";
import { buildBubblewrapCommand, buildSeatbeltProfile, detectLauncher, wrapCommand } from "../sandbox.js";

console.log("Running test_sandbox...");

{
	assert.strictEqual(detectLauncher({ platform: "darwin", exists: (path) => path === "/usr/bin/sandbox-exec" }), "sandbox-exec");
	assert.strictEqual(detectLauncher({ platform: "linux", exists: (path) => path === "/usr/bin/bwrap" }), "bwrap");
	assert.strictEqual(detectLauncher({ platform: "linux", exists: () => false }), "none");
	assert.strictEqual(detectLauncher({ force: "none" }), "none");
}

{
	const result = wrapCommand("pwd", { cwd: process.cwd(), launcher: "none" });
	assert.deepStrictEqual(result, {
		launcher: "none",
		command: "pwd",
		wrapped: false,
	});
}

{
	const profile = buildSeatbeltProfile({ cwd: "/repo", homeDir: "/Users/example", scratchDir: "/tmp/pi-scratch" });
	assert.match(profile, /\(allow file-read\*\)|\(allow default\)/);
	assert.match(profile, /\(deny file-write\*\)/);
	assert.match(profile, /\(allow file-write\* \(subpath "\/tmp\/pi-scratch"\)\)/);
	assert.match(profile, /\(deny network\*\)/);
	assert.match(profile, /repo read-only: \/repo/);
	assert.match(profile, /home read-only: \/Users\/example/);
}

{
	const result = wrapCommand("python -c 'print(1)'", { cwd: "/repo", scratchDir: "/tmp/pi-scratch", launcher: "sandbox-exec" });
	assert.strictEqual(result.launcher, "sandbox-exec");
	assert.strictEqual(result.wrapped, true);
	assert.match(result.command, /^\/usr\/bin\/sandbox-exec -p /);
	assert.match(result.command, /TMPDIR='\/tmp\/pi-scratch'/);
	assert.match(result.command, /PYTHONDONTWRITEBYTECODE=1/);
	assert.match(result.command, /deny network\*/);
	assert.match(result.command, /deny file-write\*/);
}

{
	const command = buildBubblewrapCommand("pwd", { cwd: "/repo", scratchDir: "/tmp/pi-scratch" });
	assert.match(command, /^bwrap /);
	assert.match(command, /--unshare-net/);
	assert.match(command, /--ro-bind \/ \//);
	assert.match(command, /--tmpfs '\/tmp\/pi-scratch'/);
	assert.match(command, /--setenv TMPDIR '\/tmp\/pi-scratch'/);
	assert.match(command, /--setenv PYTHONDONTWRITEBYTECODE 1/);
}

console.log("test_sandbox passed!");
