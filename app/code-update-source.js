const crypto = require("node:crypto");
const vm = require("node:vm");
const { wrap } = require("node:module");

const REPOSITORY = "evopixelro/radioserver";
const BRANCH = "main";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 1024;
const ROOT_FILES = new Set([
  "server.js", "autodj.js", "package.json", "package-lock.json",
  ".gitignore", ".gitattributes", "sc_serv.conf.example", "autodj.config.json.example", "playlist.config.json.example",
]);

function preservedDocument(value) {
  return value === "README.md" || value === "LICENSE";
}

function safePath(value) {
  return typeof value === "string" && value.length <= 240 && value.normalize("NFC") === value && value.split("/").every((part) =>
    part && part !== "." && part !== ".." && !/[\\<>:"|?*\x00-\x1f\x7f]/.test(part) &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

function managedPath(value) {
  return safePath(value) && (ROOT_FILES.has(value) ||
    (/^(?:app|tests)\/[^\r\n]+\.(?:js|json|jsonc|md|txt|liq|example)$/.test(value) &&
     value.split("/").every((part) => !part.startsWith("."))));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function blobHash(bytes) {
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function readResponse(url, maximum, fetchImplementation, signal) {
  const response = await fetchImplementation(url, {
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RadioServer code updater", "X-GitHub-Api-Version": "2022-11-28" },
  });
  try {
    if (!response.ok) {
      const detail = [403, 429].includes(response.status) ? " GitHub access or rate limit reached; retry later." : "";
      throw new Error(`Code download failed (HTTP ${response.status}).${detail}`);
    }
    const size = Number(response.headers.get("content-length"));
    if (size > maximum) throw new Error("Code download exceeds its size limit.");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) throw new Error("Code download exceeds its size limit.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, length);
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

function selectFiles(tree) {
  if (!tree || tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error("GitHub returned an incomplete code tree.");
  const names = new Set();
  const files = [];
  let size = 0;
  for (const entry of tree.tree) {
    if (!safePath(entry.path)) throw new Error("GitHub returned an unsafe file path.");
    const name = entry.path.toLowerCase();
    if (names.has(name)) throw new Error(`GitHub paths collide across platforms: ${entry.path}`);
    names.add(name);
    if (entry.type === "tree" && entry.mode === "040000") continue;
    if (!managedPath(entry.path)) continue;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
      throw new Error(`Unsupported code entry: ${entry.path}`);
    }
    size += entry.size;
    files.push(entry);
    if (files.length > MAX_FILES || size > MAX_TOTAL_BYTES) throw new Error("GitHub code snapshot exceeds its size limit.");
  }
  return files.sort((left, right) => left.path < right.path ? -1 : 1);
}

function validateSnapshot(snapshot, nodeVersion = process.versions.node) {
  if (!snapshot || !/^[a-f0-9]{40}$/.test(snapshot.commit) || !Array.isArray(snapshot.files) ||
      snapshot.files.length > MAX_FILES) throw new Error("Invalid code snapshot.");
  const files = new Map();
  const names = new Set();
  let size = 0;
  for (const file of snapshot.files) {
    if (!managedPath(file.path) || names.has(file.path.toLowerCase()) || !Buffer.isBuffer(file.bytes) ||
        ![0o644, 0o755].includes(file.mode) || file.bytes.length > MAX_FILE_BYTES || file.hash !== sha256(file.bytes)) {
      throw new Error("Invalid or conflicting code snapshot file.");
    }
    names.add(file.path.toLowerCase());
    files.set(file.path, file);
    size += file.bytes.length;
    if (size > MAX_TOTAL_BYTES) throw new Error("Code snapshot exceeds its size limit.");
    if (file.path.endsWith(".js")) {
      try { new vm.Script(wrap(file.bytes.toString("utf8").replace(/^#![^\r\n]*/, "")), { filename: file.path }); }
      catch { throw new Error(`Downloaded JavaScript is invalid: ${file.path}`); }
    }
  }
  for (const name of files.keys()) {
    const parts = name.toLowerCase().split("/");
    for (let length = 1; length < parts.length; length += 1) {
      if (names.has(parts.slice(0, length).join("/"))) throw new Error("Code file conflicts with a directory path.");
    }
  }
  for (const file of [...ROOT_FILES, "app/cli.js", "app/code-updater.js", "app/code-update-source.js"]) {
    if (!files.has(file)) throw new Error(`GitHub snapshot is missing ${file}. Publish the complete updater before using code:update.`);
  }
  let pkg;
  let lock;
  try {
    pkg = JSON.parse(files.get("package.json").bytes);
    lock = JSON.parse(files.get("package-lock.json").bytes);
  } catch { throw new Error("Downloaded package metadata is invalid JSON."); }
  if (pkg.name !== "radioserver" || pkg.type !== "commonjs" || lock.name !== pkg.name ||
      lock.packages?.[""]?.version !== pkg.version || lock.packages?.[""]?.engines?.node !== pkg.engines?.node ||
      pkg.scripts?.["code:update"] !== "node server.js update_code") {
    throw new Error("Downloaded package metadata is inconsistent or uses an unsupported updater layout.");
  }
  const required = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines?.node || "");
  const current = nodeVersion.split(".").map(Number);
  if (!required) throw new Error("The new Node.js requirement needs a manual upgrade review.");
  const minimum = required.slice(1).map(Number);
  const difference = current.map((value, index) => value - minimum[index]).find((value) => value !== 0) || 0;
  if (difference < 0) throw new Error(`Update Node.js first: the downloaded code requires Node.js ${pkg.engines.node}.`);
}

async function downloadSnapshot({ fetchImplementation = globalThis.fetch, log = console.log } = {}) {
  const signal = AbortSignal.timeout(300000);
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const json = async (url) => JSON.parse(await readResponse(url, 8 * 1024 * 1024, fetchImplementation, signal));
  log(`Checking ${REPOSITORY} (${BRANCH})...`);
  const commit = await json(`${api}/commits/${BRANCH}`);
  const treeSha = commit.commit?.tree?.sha;
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(treeSha)) throw new Error("GitHub returned an invalid commit.");
  const tree = await json(`${api}/git/trees/${treeSha}?recursive=1`);
  if (tree.sha !== treeSha) throw new Error("GitHub tree does not match the selected commit.");
  const entries = selectFiles(tree);
  log(`Downloading verified code at ${commit.sha.slice(0, 12)} (${entries.length} files)...`);
  const files = [];
  // Small batches bound parallel requests and finish before an error is returned
  for (let offset = 0; offset < entries.length; offset += 4) {
    const results = await Promise.allSettled(entries.slice(offset, offset + 4).map(async (entry) => {
      const url = `https://raw.githubusercontent.com/${REPOSITORY}/${commit.sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
      const bytes = await readResponse(url, MAX_FILE_BYTES, fetchImplementation, signal);
      if (bytes.length !== entry.size || blobHash(bytes) !== entry.sha) throw new Error(`Code checksum mismatch: ${entry.path}`);
      return { path: entry.path, bytes, hash: sha256(bytes), mode: entry.mode === "100755" ? 0o755 : 0o644 };
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    files.push(...results.map((result) => result.value));
  }
  const snapshot = { commit: commit.sha, files };
  validateSnapshot(snapshot);
  return snapshot;
}

module.exports = { REPOSITORY, BRANCH, MAX_FILE_BYTES, MAX_FILES, managedPath, preservedDocument, safePath, sha256, blobHash, selectFiles, validateSnapshot, downloadSnapshot };
