import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDesignWriteAllowed } from "../mode.ts";
import {
	OPEN_DESIGN_MAX_FILE_BYTES,
	copyProjectSnapshot,
	findOpenDesignDb,
	projectsForRoot,
	readOpenDesignProjects,
	selectSnapshotFiles,
	snapshotFolderName,
	snapshotSourceDir,
} from "../open-design.ts";

const root = await mkdtemp(join(tmpdir(), "open-design-test-"));
const home = join(root, "home");
const projectRoot = join(root, "project");
const otherRoot = join(root, "other");
const namespace = join(home, "Library", "Application Support", "Open Design", "namespaces", "release-stable");
const dataDir = join(namespace, "data");
const dbPath = join(dataDir, "app.sqlite");
const projectsDir = join(dataDir, "projects");

await mkdir(join(projectRoot, "sub"), { recursive: true });
await mkdir(otherRoot, { recursive: true });
await mkdir(projectsDir, { recursive: true });

const projectLink = join(root, "project-link");
await symlink(projectRoot, projectLink);

function sqlValue(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return `'${text.replaceAll("'", "''")}'`;
}

const rows: { id: string; name: string; metadata: unknown }[] = [
	{ id: "proj-match", name: "AMS Dashboard", metadata: { linkedDirs: [projectRoot] } },
	{ id: "proj-nested", name: "Nested Linked", metadata: { linkedDirs: [join(projectRoot, "sub")] } },
	{ id: "proj-parent", name: "Parent Linked", metadata: { linkedDirs: [dirname(projectRoot)] } },
	{ id: "proj-other", name: "Other Project", metadata: { linkedDirs: [otherRoot] } },
	{ id: "proj-unlinked", name: "Unlinked", metadata: { kind: "other" } },
	{ id: "proj-missing-dir", name: "Missing Dir", metadata: { linkedDirs: [join(root, "not-there")] } },
	{ id: "proj-symlink-dir", name: "Symlink Dir", metadata: { linkedDirs: [projectLink] } },
	{ id: "../evil", name: "Traversal", metadata: { linkedDirs: [projectRoot] } },
	{ id: "proj-long-name", name: "x".repeat(201), metadata: { linkedDirs: [projectRoot] } },
	{ id: "proj-bad-dirs", name: "Bad Dirs", metadata: { linkedDirs: "not-an-array" } },
];

execFileSync("sqlite3", [dbPath], {
	input: [
		"CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata_json TEXT);",
		...rows.map((row) => `INSERT INTO projects (id, name, metadata_json) VALUES (${sqlValue(row.id)}, ${sqlValue(row.name)}, ${sqlValue(JSON.stringify(row.metadata))});`),
	].join("\n"),
});

const matchFiles = join(projectsDir, "proj-match");
await mkdir(matchFiles, { recursive: true });
await writeFile(join(matchFiles, "screen.html"), "<html></html>");
await writeFile(join(matchFiles, "notes.md"), "# Notes\n");
await writeFile(join(matchFiles, "screen.sketch.json"), "{}");
await writeFile(join(matchFiles, "screen.html.artifact.json"), "{}");
await writeFile(join(matchFiles, "image.png"), "not copied");
await writeFile(join(matchFiles, "big.html"), "");
await truncate(join(matchFiles, "big.html"), OPEN_DESIGN_MAX_FILE_BYTES + 1);
await symlink(join(matchFiles, "image.png"), join(matchFiles, "link.html"));

await mkdir(join(projectsDir, "proj-nested"), { recursive: true });
await writeFile(join(projectsDir, "proj-nested", "nested.md"), "# Nested\n");

const capFiles = join(root, "cap-files");
await mkdir(capFiles, { recursive: true });
for (const name of ["a.html", "b.html", "c.html", "d.html", "e.html"]) {
	await writeFile(join(capFiles, name), "");
	await truncate(join(capFiles, name), OPEN_DESIGN_MAX_FILE_BYTES);
}
await writeFile(join(capFiles, "zz.md"), "x");

assert.equal(await findOpenDesignDb(home), dbPath);
assert.equal(await findOpenDesignDb(join(root, "no-open-design")), null);

const read = await readOpenDesignProjects(home);
assert.equal(read.dbPath, dbPath);
assert.equal(read.projects.length, 7);
assert.equal(read.rejected, 3);
assert.equal(read.projects.some((project) => project.id === "../evil"), false, "unsafe ids are rejected");
assert.equal(read.projects.some((project) => project.name.length > 200), false, "overlong names are rejected");
assert.equal(read.projects.find((project) => project.id === "proj-match")?.slug, "ams-dashboard");

const matched = await projectsForRoot(read.projects, projectRoot);
assert.deepEqual(matched.map((project) => project.id).sort(), ["proj-match", "proj-nested", "proj-symlink-dir"]);
assert.equal(matched.some((project) => project.id === "proj-parent"), false, "a parent linkedDir does not match");
assert.equal(matched.some((project) => project.id === "proj-missing-dir"), false, "a missing linkedDir does not match");

const selection = await selectSnapshotFiles(matchFiles);
assert.deepEqual(selection.selected, ["notes.md", "screen.html", "screen.html.artifact.json", "screen.sketch.json"]);
assert.deepEqual(selection.skipped, [
	{ name: "big.html", reason: "exceeds 5 MiB" },
	{ name: "link.html", reason: "symlink" },
]);
assert.equal(selection.selected.includes("image.png"), false, "other file types are ignored");

const capSelection = await selectSnapshotFiles(capFiles);
assert.equal(capSelection.selected.length, 5);
assert.deepEqual(capSelection.skipped, [{ name: "zz.md", reason: "exceeds 25 MiB total" }]);

const matchProject = read.projects.find((project) => project.id === "proj-match");
assert.ok(matchProject);
assert.equal(snapshotFolderName(matchProject), "ams-dashboard-proj-mat");
assert.equal(snapshotSourceDir(read.dbPath, matchProject.id), matchFiles);

const existingFolder = join(projectRoot, "docs", "design", "reference", "open-design", snapshotFolderName(matchProject));
await mkdir(existingFolder, { recursive: true });
await writeFile(join(existingFolder, "stale.txt"), "old snapshot");
const copied = await copyProjectSnapshot(projectRoot, matchProject, matchFiles);
assert.equal(copied.folder, "ams-dashboard-proj-mat");
assert.equal(copied.copied.length, 4);
assert.equal(copied.skipped.length, 2);
assert.deepEqual((await readdir(existingFolder)).sort(), copied.copied.slice().sort());
assert.equal(await readFile(join(existingFolder, "notes.md"), "utf8"), "# Notes\n");
assert.equal(await readdir(join(projectRoot, "docs", "design", "reference", "open-design")).then((names) => names.some((name) => name.includes(".staging-") || name.includes(".backup-"))), false);

const missingProject = read.projects.find((project) => project.id === "proj-missing-dir");
assert.ok(missingProject);
const failedFolder = join(projectRoot, "docs", "design", "reference", "open-design", snapshotFolderName(missingProject));
await mkdir(failedFolder, { recursive: true });
await writeFile(join(failedFolder, "sentinel.txt"), "keep");
await assert.rejects(copyProjectSnapshot(projectRoot, missingProject, join(projectsDir, "does-not-exist")));
assert.equal(await readFile(join(failedFolder, "sentinel.txt"), "utf8"), "keep", "a failed copy keeps the previous snapshot");

assert.equal(isDesignWriteAllowed("design"), true);
assert.equal(isDesignWriteAllowed("build"), true);
assert.equal(isDesignWriteAllowed("off"), true);
for (const mode of ["discuss", "plan", "review"] as const) assert.equal(isDesignWriteAllowed(mode), false, `${mode} blocks the pull`);
assert.equal(isDesignWriteAllowed(undefined), false, "unknown mode blocks the pull");

const unknownHome = join(root, "unknown-home");
const unknownDb = join(unknownHome, "Library", "Application Support", "Open Design", "namespaces", "release-stable", "data", "app.sqlite");
await mkdir(dirname(unknownDb), { recursive: true });
execFileSync("sqlite3", [unknownDb], { input: "CREATE TABLE unrelated (x TEXT);" });
await assert.rejects(readOpenDesignProjects(unknownHome), /schema is unknown/);
await assert.rejects(readOpenDesignProjects(join(root, "no-open-design")), /database not found/);

await rm(root, { recursive: true, force: true });
console.log("open design snapshot tests passed");
