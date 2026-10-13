#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const npmrcBytes = Buffer.from("legacy-peer-deps=true\n", "utf8");
const maxCommandOutput = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let tgz;
  let version;
  let npmrc = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tgz" && tgz === undefined && argv[index + 1]) tgz = argv[++index];
    else if (arg === "--version" && version === undefined && argv[index + 1]) version = argv[++index];
    else if (arg === "--npmrc" && !npmrc) npmrc = true;
    else fail(`unexpected or incomplete argument: ${arg}`);
  }
  if (!tgz || !version) fail("usage: node scripts/release-branch.mjs --tgz <path> --version <X.Y.Z> [--npmrc]");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail(`invalid release version: ${version}`);
  return { tgz: resolve(tgz), version, npmrc };
}

function command(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: "utf8",
    maxBuffer: maxCommandOutput,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && !/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(key)) delete env[key];
  }
  return env;
}

function git(repo, args) {
  return command("git", ["-C", repo, ...args], { env: gitEnv() }).trimEnd();
}

function gitBuffer(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    maxBuffer: maxCommandOutput,
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
  });
}

function tarEnv() {
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  delete env.TAR_OPTIONS;
  delete env.GZIP;
  return env;
}

function tarText(args) {
  return command("tar", args, { env: tarEnv() });
}

function outputLines(output) {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function safeArchivePath(rawPath, directory) {
  if (
    rawPath.length === 0 ||
    rawPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(rawPath) ||
    rawPath.startsWith("/") ||
    /^[A-Za-z]:/.test(rawPath)
  ) fail(`unsafe archive path: ${JSON.stringify(rawPath)}`);

  let path = rawPath;
  if (directory && path.endsWith("/")) path = path.slice(0, -1);
  if (path.endsWith("/")) fail(`file path has trailing slash: ${JSON.stringify(rawPath)}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`unsafe archive path: ${JSON.stringify(rawPath)}`);
  if (parts[0] !== "package") fail(`archive entry is outside package/: ${JSON.stringify(rawPath)}`);
  if (parts.some((part) => part.toLowerCase() === ".git")) fail(`archive path contains reserved .git component: ${JSON.stringify(rawPath)}`);
  if (parts.includes(".npmrc")) fail("tarball must not contain .npmrc");
  if (parts.length === 1 && !directory) fail("package root entry must be a directory");
  return parts.length === 1 ? "" : parts.slice(1).join("/");
}

function inspectArchive(tgz) {
  const paths = outputLines(tarText(["-tzf", tgz]));
  const verbose = outputLines(tarText(["-tvzf", tgz]));
  if (paths.length === 0 || paths.length !== verbose.length) fail("tar listings are malformed or ambiguous");

  const entries = [];
  const seen = new Map();
  const foldedPaths = new Map();
  for (let index = 0; index < paths.length; index += 1) {
    const mode = verbose[index].slice(0, 10);
    if (!/^[-d][rwxstST-]{9}$/.test(mode)) {
      fail(`archive contains link or special entry: ${JSON.stringify(paths[index])}`);
    }
    const directory = mode[0] === "d";
    const path = safeArchivePath(paths[index], directory);
    if (path) {
      const kind = directory ? "directory" : "file";
      const prior = seen.get(path);
      if (prior) fail(`archive contains duplicate path: ${path}`);
      seen.set(path, kind);
      const components = path.split("/");
      for (let part = 1; part <= components.length; part += 1) {
        const prefix = components.slice(0, part).join("/");
        const folded = prefix.toLowerCase();
        if (foldedPaths.has(folded) && foldedPaths.get(folded) !== prefix) {
          fail(`archive contains case-colliding path: ${prefix}`);
        }
        foldedPaths.set(folded, prefix);
      }
      for (let part = 1; part < components.length; part += 1) {
        const parent = components.slice(0, part).join("/");
        if (seen.get(parent) === "file") fail(`archive file is parent of another entry: ${parent}`);
      }
      if (!directory && [...seen.keys()].some((candidate) => candidate.startsWith(`${path}/`))) {
        fail(`archive file conflicts with directory: ${path}`);
      }
    }
    entries.push({
      path,
      directory,
      executable: /[xst]/.test(`${mode[3]}${mode[6]}${mode[9]}`),
    });
  }
  if (!entries.some((entry) => entry.path === "package.json" && !entry.directory)) {
    fail("tarball is missing package/package.json");
  }
  return entries;
}

function packageVersion(tgz) {
  let manifest;
  try {
    manifest = JSON.parse(tarText(["-xOzf", tgz, "package/package.json"]));
  } catch (error) {
    fail(`cannot read package/package.json: ${error.message}`);
  }
  return manifest.version;
}

function optionalRef(repo, ref) {
  try {
    return git(repo, ["rev-parse", "--verify", ref]);
  } catch (error) {
    if (error.status === 128) return undefined;
    throw error;
  }
}

function mainSnapshot(repo) {
  return {
    branch: git(repo, ["branch", "--show-current"]),
    head: git(repo, ["rev-parse", "HEAD"]),
    status: git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

function assertMainUnchanged(repo, initial) {
  const current = mainSnapshot(repo);
  if (current.branch !== initial.branch || current.head !== initial.head || current.status !== initial.status) {
    fail("main worktree or HEAD changed during release operation");
  }
}

function validateRepo(repo) {
  if (git(repo, ["rev-parse", "--is-bare-repository"]) !== "false") fail("caller repository must be a non-bare worktree");
  const initial = mainSnapshot(repo);
  if (initial.branch !== "main") fail("caller worktree must be on main");
  if (initial.status !== "") fail("main worktree must be clean");
  return initial;
}

function assertExternalTemp(tempRoot, repo) {
  const rel = relative(realpathSync(repo), realpathSync(tempRoot));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    fail("temporary worktree must be outside caller repository");
  }
}

function extractFiles(tgz, entries, worktree, includeNpmrc) {
  command("tar", ["-xzf", tgz, "-C", worktree, "--strip-components=1"], { env: tarEnv() });

  const expected = new Map();
  for (const entry of entries) {
    if (entry.directory || !entry.path) continue;
    const path = join(worktree, ...entry.path.split("/"));
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) fail(`extracted entry is not a regular file: ${entry.path}`);
    chmodSync(path, entry.executable ? 0o755 : 0o644);
    expected.set(entry.path, { bytes: readFileSync(path), executable: entry.executable });
  }
  if (includeNpmrc) {
    const path = join(worktree, ".npmrc");
    writeFileSync(path, npmrcBytes, { flag: "wx", mode: 0o644 });
    chmodSync(path, 0o644);
    expected.set(".npmrc", { bytes: npmrcBytes, executable: false });
  }

  const actual = new Set();
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(path);
      if (!prefix && name === ".git") {
        if (!info.isFile()) fail("worktree .git entry is not a file");
      } else if (info.isSymbolicLink()) fail(`extracted symlink refused: ${relativePath}`);
      else if (info.isDirectory()) walk(path, relativePath);
      else if (info.isFile()) actual.add(relativePath);
      else fail(`extracted special entry refused: ${relativePath}`);
    }
  }
  walk(worktree);
  if (actual.size !== expected.size || [...expected.keys()].some((path) => !actual.has(path))) {
    fail("extracted file list differs from tarball listing");
  }
  return expected;
}

function treeEntries(repo, treeish) {
  const raw = gitBuffer(repo, ["ls-tree", "-rz", "--full-tree", treeish]);
  const entries = new Map();
  for (const record of raw.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode, type, oid });
  }
  return entries;
}

function assertTree(repo, treeish, expected) {
  const actual = treeEntries(repo, treeish);
  if (actual.size !== expected.size) fail("release tree file count differs from tarball");
  for (const [name, file] of expected) {
    const entry = actual.get(name);
    const mode = file.executable ? "100755" : "100644";
    if (!entry || entry.mode !== mode || entry.type !== "blob") fail(`release tree type or mode differs for ${name}`);
    const bytes = gitBuffer(repo, ["cat-file", "blob", entry.oid]);
    if (!bytes.equals(file.bytes)) fail(`release tree content differs for ${name}`);
  }
}

function cleanup(repo, worktree, tempRoot) {
  let error;
  if (worktree && existsSync(worktree)) {
    try {
      git(repo, ["worktree", "remove", "--force", worktree]);
    } catch (removeError) {
      try {
        rmSync(worktree, { recursive: true, force: true });
        git(repo, ["worktree", "prune", "--expire", "now"]);
      } catch (fallbackError) {
        error = new Error(`${removeError.message}; cleanup fallback failed: ${fallbackError.message}`);
      }
    }
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch (removeError) {
    error = error ? new Error(`${error.message}; temp cleanup failed: ${removeError.message}`) : removeError;
  }
  return error;
}

function rollback(repo, version, previousRelease, commit) {
  if (!commit) return;
  const tag = `refs/tags/v${version}`;
  if (optionalRef(repo, `${tag}^{}`) === commit) git(repo, ["tag", "-d", `v${version}`]);
  const release = optionalRef(repo, "refs/heads/release");
  if (release !== commit) return;
  if (previousRelease) git(repo, ["update-ref", "refs/heads/release", previousRelease, commit]);
  else git(repo, ["update-ref", "-d", "refs/heads/release", commit]);
}

function release({ tgz, version, npmrc }) {
  const entries = inspectArchive(tgz);
  if (packageVersion(tgz) !== version) fail(`tarball version does not match requested ${version}`);

  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const initialMain = validateRepo(repo);
  const tag = `v${version}`;
  if (optionalRef(repo, `refs/tags/${tag}`)) fail(`tag ${tag} already exists`);
  const previousRelease = optionalRef(repo, "refs/heads/release");
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-release-branch-"));
  const worktree = join(tempRoot, "worktree");
  let commit;
  let finalized = false;
  let failure;

  try {
    assertExternalTemp(tempRoot, repo);
    if (previousRelease) git(repo, ["worktree", "add", worktree, "release"]);
    else git(repo, ["worktree", "add", "--orphan", "-b", "release", worktree]);

    git(worktree, ["rm", "-r", "-f", "--ignore-unmatch", "--", "."]);
    git(worktree, ["clean", "-f", "-d", "-x", "--", "."]);
    const files = extractFiles(tgz, entries, worktree, npmrc);
    git(worktree, ["-c", "core.filemode=true", "add", "-f", "-A", "--", "."]);
    const hooks = join(tempRoot, "empty-hooks");
    mkdirSync(hooks);
    git(worktree, [
      "-c", `core.hooksPath=${hooks}`, "commit",
      "-m", `Release v${version}`,
      "-m", `Source: main@${initialMain.head}`,
    ]);
    commit = git(worktree, ["rev-parse", "HEAD"]);

    if (previousRelease) {
      if (git(worktree, ["rev-parse", "HEAD^"]) !== previousRelease) fail("release commit has unexpected parent");
    } else if (git(worktree, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).length !== 1) {
      fail("first release commit must be an orphan");
    }
    assertTree(worktree, commit, files);

    git(repo, ["tag", "-a", tag, "-m", `Release ${tag}`, commit]);
    const tagRef = `refs/tags/${tag}`;
    if (git(repo, ["cat-file", "-t", tagRef]) !== "tag") fail("release tag is not annotated");
    if (git(repo, ["rev-parse", `${tagRef}^{}`]) !== commit) fail("release tag points to wrong commit");
    assertTree(repo, tagRef, files);
    finalized = true;
  } catch (error) {
    failure = error;
  }

  const cleanupError = cleanup(repo, worktree, tempRoot);
  if (cleanupError && !failure) failure = new Error(`release worktree cleanup failed: ${cleanupError.message}`);
  if (failure && !finalized) {
    try {
      rollback(repo, version, previousRelease, commit);
    } catch (error) {
      failure = new Error(`${failure.message}; release ref rollback failed: ${error.message}`);
    }
  }
  try {
    assertMainUnchanged(repo, initialMain);
  } catch (error) {
    failure = failure ? new Error(`${failure.message}; ${error.message}`) : error;
  }
  if (failure) throw failure;
  return { tag, commit };
}

try {
  const result = release(parseArgs(process.argv.slice(2)));
  console.log(`Created ${result.tag} on release (${result.commit}). Never pushed.`);
} catch (error) {
  console.error(`release-branch: ${error.message}`);
  process.exitCode = 1;
}
