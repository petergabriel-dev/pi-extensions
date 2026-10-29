import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function exists(filePath: string): boolean {
	try { fs.accessSync(filePath); return true; } catch { return false; }
}

function homeRealPath(): string | null {
	try { return fs.realpathSync(os.homedir()); } catch { return null; }
}

/** Nearest `.pi` ancestor root, ignoring Pi's global agent dir at the user's home. */
export function findProjectRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	const homeReal = homeRealPath();
	while (true) {
		if (exists(path.join(dir, ".pi"))) {
			let real: string;
			try { real = fs.realpathSync(dir); } catch { return null; }
			if (real !== homeReal) return real;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
