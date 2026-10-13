#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./release-branch.mjs", import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "test-release-branch-"));

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function snapshotMain(repo) {
  return {
    branch: git(repo, "branch", "--show-current"),
    head: git(repo, "rev-parse", "HEAD"),
    tree: execFileSync("git", ["-C", repo, "ls-tree", "-rz", "--full-tree", "HEAD"]),
    status: execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    staged: execFileSync("git", ["-C", repo, "diff", "--cached", "--binary"]),
    changed: execFileSync("git", ["-C", repo, "diff", "--binary", "HEAD"]),
  };
}

function assertMainUnchanged(repo, before) {
  assert.deepEqual(snapshotMain(repo), before, "main HEAD, tree, or worktree changed");
  const worktrees = git(repo, "worktree", "list", "--porcelain");
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1, "temporary worktree was not removed");
}

function createRepo(name) {
  const repo = join(testRoot, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Release Test");
  git(repo, "config", "user.email", "release-test@example.invalid");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "0.8.0" }, null, 2) + "\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "main.js"), "export const main = true;\n");
  git(repo, "add", "--", "package.json", "src/main.js");
  git(repo, "commit", "-m", "fixture main");
  return repo;
}

function tarOctal(header, offset, length, value) {
  header.write(String(value.toString(8).padStart(length - 1, "0")), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarFile(path, content, type = "0", linkname = "", mode = 0o644) {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  tarOctal(header, 100, 8, type === "2" ? 0o777 : mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, bytes.length);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return [header, bytes, padding];
}

function createTgz(name, version, files = { "index.js": "export default 1;\n" }, specialEntry, executablePaths = []) {
  const entries = {
    "package/package.json": JSON.stringify({ name: "fixture", version }, null, 2) + "\n",
    ...Object.fromEntries(Object.entries(files).map(([path, content]) => [`package/${path}`, content])),
  };
  const tar = [
    ...Object.entries(entries).flatMap(([path, content]) =>
      tarFile(path, content, "0", "", executablePaths.includes(path.slice("package/".length)) ? 0o755 : 0o644),
    ),
    ...(specialEntry ? tarFile(`package/${specialEntry.path}`, "", specialEntry.type, specialEntry.linkname) : []),
    Buffer.alloc(1024),
  ];
  const tgz = join(testRoot, `${name}.tgz`);
  writeFileSync(tgz, gzipSync(Buffer.concat(tar)));
  return tgz;
}

function invoke(repo, tgz, version, npmrc = false) {
  const args = [scriptPath, "--tgz", tgz, "--version", version];
  if (npmrc) args.push("--npmrc");
  return run(process.execPath, args, repo);
}

function assertReleaseTree(repo, ref, expectedPaths) {
  const raw = execFileSync("git", ["-C", repo, "ls-tree", "-rz", "--name-only", ref]);
  const actual = raw.toString("utf8").split("\0").filter(Boolean).sort();
  assert.deepEqual(actual, [...expectedPaths].sort());
}

try {
  const successRepo = createRepo("success");
  const firstTgz = createTgz("first", "0.8.0", {
    "index.js": "export default 1;\n",
    "nested/data.json": "{\"ok\":true}\n",
    "bin/run": "#!/bin/sh\necho ok\n",
  }, undefined, ["bin/run"]);
  const originalMain = snapshotMain(successRepo);
  const first = invoke(successRepo, firstTgz, "0.8.0", true);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstCommit = git(successRepo, "rev-parse", "refs/heads/release");
  const firstParents = git(successRepo, "rev-list", "--parents", "-n", "1", firstCommit).split(/\s+/);
  assert.equal(firstParents.length, 1, "first release commit must be orphaned");
  assertReleaseTree(successRepo, "v0.8.0", ["package.json", "index.js", "nested/data.json", "bin/run", ".npmrc"]);
  assert.match(git(successRepo, "ls-tree", "v0.8.0", "--", "bin/run"), /^100755 blob /);
  assert.equal(git(successRepo, "cat-file", "-t", "refs/tags/v0.8.0"), "tag");
  assert.equal(git(successRepo, "rev-parse", "v0.8.0^{}"), firstCommit);
  assert.deepEqual(
    execFileSync("git", ["-C", successRepo, "show", "v0.8.0:.npmrc"]),
    Buffer.from("legacy-peer-deps=true\n"),
  );
  const firstMessage = git(successRepo, "show", "-s", "--format=%B", firstCommit);
  assert.match(firstMessage, /^Release v0\.8\.0\n\nSource: main@[0-9a-f]{40}$/);
  assertMainUnchanged(successRepo, originalMain);

  const secondTgz = createTgz("second", "0.8.1", { "index.js": "export default 2;\n" });
  const beforeSecond = snapshotMain(successRepo);
  const second = invoke(successRepo, secondTgz, "0.8.1");
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondCommit = git(successRepo, "rev-parse", "refs/heads/release");
  assert.equal(git(successRepo, "rev-parse", `${secondCommit}^`), firstCommit);
  assertReleaseTree(successRepo, "v0.8.1", ["package.json", "index.js"]);
  assert.throws(() => git(successRepo, "show", "v0.8.1:.npmrc"));
  assertMainUnchanged(successRepo, beforeSecond);

  const dirtyRepo = createRepo("dirty");
  const validTgz = createTgz("dirty-valid", "0.8.0");
  writeFileSync(join(dirtyRepo, "src", "main.js"), "modified main\n");
  const dirtyBefore = snapshotMain(dirtyRepo);
  const dirty = invoke(dirtyRepo, validTgz, "0.8.0");
  assert.notEqual(dirty.status, 0, "dirty main must be refused");
  assert.match(dirty.stderr, /clean/);
  assertMainUnchanged(dirtyRepo, dirtyBefore);
  assert.equal(run("git", ["-C", dirtyRepo, "show-ref", "--verify", "--quiet", "refs/heads/release"], dirtyRepo).status, 1);

  const taggedRepo = createRepo("tagged");
  git(taggedRepo, "tag", "v0.8.0");
  const taggedBefore = snapshotMain(taggedRepo);
  const alreadyTagged = invoke(taggedRepo, validTgz, "0.8.0");
  assert.notEqual(alreadyTagged.status, 0, "existing tag must be refused");
  assert.match(alreadyTagged.stderr, /already exists/);
  assertMainUnchanged(taggedRepo, taggedBefore);
  assert.equal(run("git", ["-C", taggedRepo, "show-ref", "--verify", "--quiet", "refs/heads/release"], taggedRepo).status, 1);

  const unsafeRepo = createRepo("unsafe");
  const unsafeTgz = createTgz("unsafe", "0.8.0", { "../escape.txt": "must not extract\\n" });
  const unsafeBefore = snapshotMain(unsafeRepo);
  const unsafe = invoke(unsafeRepo, unsafeTgz, "0.8.0");
  assert.notEqual(unsafe.status, 0, "unsafe archive path must be refused");
  assert.match(unsafe.stderr, /unsafe archive path/);
  assertMainUnchanged(unsafeRepo, unsafeBefore);
  assert.equal(run("git", ["-C", unsafeRepo, "show-ref", "--verify", "--quiet", "refs/heads/release"], unsafeRepo).status, 1);

  const npmrcRepo = createRepo("archive-npmrc");
  const archiveNpmrc = createTgz("archive-npmrc", "0.8.0", { ".npmrc": "wrong=true\\n" });
  const npmrcBefore = snapshotMain(npmrcRepo);
  const rejectedNpmrc = invoke(npmrcRepo, archiveNpmrc, "0.8.0", true);
  assert.notEqual(rejectedNpmrc.status, 0, "tarball .npmrc must be refused");
  assert.match(rejectedNpmrc.stderr, /must not contain \.npmrc/);
  assertMainUnchanged(npmrcRepo, npmrcBefore);
  assert.equal(run("git", ["-C", npmrcRepo, "show-ref", "--verify", "--quiet", "refs/heads/release"], npmrcRepo).status, 1);

  for (const [type, label, linkname] of [
    ["2", "symlink", "package/package.json"],
    ["1", "hardlink", "package/package.json"],
    ["6", "fifo", ""],
  ]) {
    const repo = createRepo(`special-${label}`);
    const tgz = createTgz(`special-${label}`, "0.8.0", {}, { path: label, type, linkname });
    const before = snapshotMain(repo);
    const result = invoke(repo, tgz, "0.8.0");
    assert.notEqual(result.status, 0, `${label} archive entry must be refused`);
    assert.match(result.stderr, /link or special entry/);
    assertMainUnchanged(repo, before);
    assert.equal(run("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/release"], repo).status, 1);
  }

  const mismatchRepo = createRepo("mismatch");
  const mismatchTgz = createTgz("mismatch", "0.8.0");
  const mismatchBefore = snapshotMain(mismatchRepo);
  const mismatch = invoke(mismatchRepo, mismatchTgz, "0.8.2");
  assert.notEqual(mismatch.status, 0, "version mismatch must be refused");
  assert.match(mismatch.stderr, /does not match requested/);
  assertMainUnchanged(mismatchRepo, mismatchBefore);
  assert.equal(run("git", ["-C", mismatchRepo, "show-ref", "--verify", "--quiet", "refs/heads/release"], mismatchRepo).status, 1);

  console.log("release-branch tests passed");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
