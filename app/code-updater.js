const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const source = require("./code-update-source");
const radio = require("./process-manager");
const autodj = require("./autodj-manager");
const { radioLogPaths } = require("./log-cleanup");
const { loadPlaylistConfig } = require("./playlist-generator");
const { parseShoutcastConfig } = require("./shoutcast-config");

const STATE_DIR = ".run/code-update";
const MANIFEST = `${STATE_DIR}/manifest.json`;
const JOURNAL = `${STATE_DIR}/transaction.json`;

function createLogger(output, color = Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env)) {
  const colors = { SKIP: 90, ADDED: 32, UPDATED: 32, REMOVED: 33, RESTORE: 33, LOCAL: 31 };
  return (message) => output(color ? message.replace(/^\[ (\w+) \]/, (marker, state) =>
    colors[state] ? `[ \u001b[${colors[state]}m${state}\u001b[0m ]` : marker) : message);
}

function optionsFrom(args) {
  if (new Set(args).size !== args.length || args.some((arg) => !["--check", "--force", "--rollback"].includes(arg)) ||
      (args.includes("--rollback") && args.length !== 1)) {
    throw new Error("Usage: npm run code:update [-- --check | --force | --rollback]");
  }
  return { check: args.includes("--check"), force: args.includes("--force"), rollback: args.includes("--rollback") };
}

function info(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function target(root, relative) {
  if (!source.safePath(relative)) throw new Error("Unsafe updater path.");
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    if (info(current)) {
      const collision = fs.readdirSync(current).find((name) => name.normalize("NFC").toLowerCase() === parts[index].toLowerCase() && name !== parts[index]);
      if (collision) throw new Error(`Local path casing conflicts with the update: ${relative}`);
    }
    current = path.join(current, parts[index]);
    const entry = info(current);
    if (!entry) continue;
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory()) ||
        (entry.isFile() && entry.nlink !== 1)) throw new Error(`Refusing a linked or invalid updater path: ${relative}`);
  }
  return current;
}

function readFile(root, relative, maximum = source.MAX_FILE_BYTES) {
  const file = target(root, relative);
  const entry = info(file);
  if (!entry) return null;
  if (!entry.isFile() || entry.size > maximum) throw new Error(`Invalid or oversized updater file: ${relative}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > maximum) {
      throw new Error(`File changed while reading: ${relative}`);
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length > maximum) throw new Error(`File grew while reading: ${relative}`);
    return { bytes, hash: source.sha256(bytes), mode: opened.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}

function readJson(root, relative) {
  const file = readFile(root, relative);
  if (!file) return null;
  try {
    const value = JSON.parse(file.bytes);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid state object");
    return value;
  }
  catch { throw new Error(`Invalid updater state: ${relative}. Restore it from backup before updating.`); }
}

function writeFile(root, relative, bytes, mode = 0o600) {
  const file = target(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  target(root, relative);
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    target(root, relative);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (info(temporary)) fs.unlinkSync(temporary);
  }
}

function writeJson(root, relative, value) {
  writeFile(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function removeFile(root, relative) {
  const file = target(root, relative);
  const entry = info(file);
  if (!entry) return;
  if (!entry.isFile()) throw new Error(`Refusing to remove a non-regular file: ${relative}`);
  fs.unlinkSync(file);
}

function descriptor(file) {
  return file ? { hash: file.hash, mode: file.mode } : null;
}

function validDescriptor(value) {
  return value && /^[a-f0-9]{64}$/.test(value.hash) && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777;
}

function same(left, right) {
  return left === null ? right === null : !!right && left.hash === right.hash &&
    (process.platform === "win32" || left.mode === right.mode);
}

function managedManifest(manifest) {
  return manifest === null ? null : {
    ...manifest, files: Object.fromEntries(Object.entries(manifest.files).filter(([name]) => source.managedPath(name))),
  };
}

function validateManifest(manifest) {
  if (manifest === null) return;
  if (manifest.version !== 1 || manifest.repository !== source.REPOSITORY || !/^[a-f0-9]{40}$/.test(manifest.commit) ||
      !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== "object" || Object.keys(manifest.files).length > source.MAX_FILES) {
    throw new Error("Invalid code update manifest. Restore the saved manifest before updating.");
  }
  const names = new Set();
  for (const [name, value] of Object.entries(manifest.files)) {
    if ((!source.managedPath(name) && !source.preservedDocument(name)) || names.has(name.toLowerCase()) || !validDescriptor(value)) throw new Error("Invalid code update manifest entry.");
    names.add(name.toLowerCase());
  }
}

function validateJournal(journal) {
  if (!journal || journal.version !== 1 || !["pending", "complete", "rolled-back"].includes(journal.status) ||
      !/^\d{13}-[a-f0-9-]{36}$/.test(journal.id) || !Array.isArray(journal.changes) || journal.changes.length > source.MAX_FILES * 2) {
    throw new Error("Invalid code update transaction. Restore the backup manually before continuing.");
  }
  if (!journal.after) throw new Error("Invalid code update transaction manifest.");
  validateManifest(journal.before);
  validateManifest(journal.after);
  const names = new Set();
  for (const change of journal.changes) {
    if (!change || (!source.managedPath(change.path) && !source.preservedDocument(change.path)) || names.has(change.path.toLowerCase()) ||
        (change.before !== null && !validDescriptor(change.before)) || (change.after !== null && !validDescriptor(change.after))) {
      throw new Error("Invalid code update transaction entry.");
    }
    names.add(change.path.toLowerCase());
  }
}

function assertNoPendingUpdate(serverRoot) {
  const journal = readJson(fs.realpathSync(serverRoot), JOURNAL);
  if (!journal) return;
  validateJournal(journal);
  if (journal.status === "pending") throw new Error("A code update was interrupted. Keep both services stopped and run npm run code:update -- --rollback.");
}

function assertStopped(config) {
  if (radio.getStatus(config).running || autodj.status(autodj.getConfig(config.serverRoot)).running) {
    throw new Error("Stop AutoDJ and SHOUTcast before updating code: npm run autodj:stop, then npm run stop. Disable supervisor restart loops during the update.");
  }
}

function assertDataSeparation(config, paths) {
  const auto = autodj.getConfig(config.serverRoot);
  const protectedPaths = [config.configPath, config.runDirectory, config.logDirectory, config.binaryPath,
    auto.configPath, auto.binaryPath, ...radioLogPaths(config)].filter(Boolean).map((file) => path.resolve(config.serverRoot, file));
  if (fs.existsSync(path.join(config.serverRoot, "playlist.config.json"))) {
    const playlist = loadPlaylistConfig({ serverRoot: config.serverRoot });
    protectedPaths.push(...playlist.configuredPlaylists.flatMap((entry) => [entry.directory, entry.outputFile]));
  }
  if (fs.existsSync(config.configPath)) {
    const settings = parseShoutcastConfig(fs.readFileSync(config.configPath, "utf8"));
    for (const [key, value] of settings) {
      if (value && /file(?:_\d+)?$/.test(key)) protectedPaths.push(path.resolve(config.serverRoot, value));
    }
  }
  const canonical = (file) => {
    const suffix = [];
    let current = path.resolve(file);
    while (!info(current)) {
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Cannot resolve a configured runtime data path.");
      suffix.unshift(path.basename(current));
      current = parent;
    }
    return path.join(fs.realpathSync(current), ...suffix).toLowerCase();
  };
  const protectedLocations = protectedPaths.map(canonical);
  for (const relative of paths) {
    const file = canonical(path.resolve(config.serverRoot, relative));
    if (protectedLocations.some((dataPath) => file === dataPath || file.startsWith(`${dataPath}${path.sep}`))) {
      throw new Error(`Runtime data overlaps managed code: ${relative}. Move that data outside the code directories first.`);
    }
  }
}

function restore(root, journal, config, log) {
  validateJournal(journal);
  if (journal.status === "rolled-back") throw new Error("The last code update has already been rolled back.");
  const changes = journal.changes.filter((change) => source.managedPath(change.path));
  assertDataSeparation(config, changes.map((change) => change.path));
  const backups = new Map();
  for (const change of changes) {
    const current = readFile(root, change.path);
    if (!same(current, change.before) && !same(current, change.after)) throw new Error(`Rollback would overwrite a later local edit: ${change.path}`);
    if (change.before) {
      const saved = readFile(root, `${STATE_DIR}/backups/${journal.id}/${change.path}`);
      if (!saved || saved.hash !== change.before.hash) throw new Error(`Missing or damaged code backup: ${change.path}`);
      backups.set(change.path, saved.bytes);
    }
  }
  const manifest = readJson(root, MANIFEST);
  validateManifest(manifest);
  const currentManifest = JSON.stringify(managedManifest(manifest));
  if (currentManifest !== JSON.stringify(managedManifest(journal.before)) && currentManifest !== JSON.stringify(managedManifest(journal.after))) {
    throw new Error("The manifest changed after this update; rollback requires a manual review.");
  }
  journal.status = "pending";
  writeJson(root, JOURNAL, journal);
  for (const change of [...changes].reverse()) {
    if (same(readFile(root, change.path), change.before)) continue;
    if (change.before) writeFile(root, change.path, backups.get(change.path), change.before.mode);
    else removeFile(root, change.path);
    log(`[ RESTORE ] ${change.path}`);
  }
  if (journal.before) writeJson(root, MANIFEST, managedManifest(journal.before));
  else removeFile(root, MANIFEST);
  journal.status = "rolled-back";
  writeJson(root, JOURNAL, journal);
  log("Code rollback completed. Backups were kept; run npm run doctor before starting services.");
}

async function updateCode(config, args = [], { downloadSnapshot = source.downloadSnapshot, log: output = console.log, color } = {}) {
  const log = createLogger(output, color);
  const options = optionsFrom(args);
  const root = fs.realpathSync(config.serverRoot);
  if (!options.check) {
    if (info(path.join(root, ".git"))) throw new Error("This is a Git checkout. Use your Git deployment workflow; code:update is for FTP/archive installations.");
    assertStopped(config);
  }
  const journal = readJson(root, JOURNAL);
  if (journal) validateJournal(journal);
  if (options.rollback) {
    if (!journal) throw new Error("No code update is available to roll back.");
    restore(root, journal, config, log);
    return { rolledBack: true };
  }
  assertNoPendingUpdate(root);
  const before = readJson(root, MANIFEST);
  validateManifest(before);
  const snapshot = await downloadSnapshot({ log });
  source.validateSnapshot(snapshot);
  const incoming = new Map(snapshot.files.map((file) => [file.path, file]));
  const names = [...new Set([...incoming.keys(), ...Object.keys(before?.files || {})])].filter(source.managedPath).sort();
  assertDataSeparation(config, names);
  const changes = [];
  const conflicts = [];
  const originals = new Map();
  const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  for (const name of names) {
    const local = readFile(root, name);
    const remote = incoming.get(name) || null;
    const previous = before?.files[name] || null;
    if (same(local, remote)) {
      counts.unchanged += 1;
      log(`[ SKIP ] ${name}`);
      continue;
    }
    if (before && !same(local, previous)) conflicts.push(name);
    const action = !remote ? "removed" : !local ? "added" : "updated";
    counts[action] += 1;
    changes.push({ path: name, before: descriptor(local), after: descriptor(remote), action });
    if (local) originals.set(name, local.bytes);
  }
  for (const name of conflicts) log(`[ LOCAL ] ${name}`);
  if (conflicts.length && !options.force) throw new Error("Local code changes detected. Review them, then use npm run code:update -- --force only to replace them with a backup.");
  const total = changes.length;
  const summary = `${total} files changed (${counts.added} added, ${counts.updated} updated, ${counts.removed} removed); ${counts.unchanged} unchanged.`;
  if (options.check) {
    for (const change of changes) log(`[ ${change.action.toUpperCase()} ] ${change.path}`);
    log(`Code update preview: ${summary} No files were written.`);
    return { ...counts, total, commit: snapshot.commit };
  }
  assertStopped(config);
  const after = { version: 1, repository: source.REPOSITORY, commit: snapshot.commit,
    files: Object.fromEntries(snapshot.files.map((file) => [file.path, descriptor(file)])) };
  if (!total) {
    const previous = managedManifest(before);
    const sameInventory = previous && Object.keys(previous.files).length === snapshot.files.length &&
      snapshot.files.every((file) => same(previous.files[file.path] || null, file));
    // A commit affecting only excluded data must not invalidate the last rollback
    if (!sameInventory) writeJson(root, MANIFEST, after);
    else if (Object.keys(previous.files).length !== Object.keys(before.files).length) writeJson(root, MANIFEST, previous);
    log(`Code is up to date (${snapshot.commit.slice(0, 12)}). ${summary}`);
    return { ...counts, total, commit: snapshot.commit };
  }
  if (!before) log("First code update: replacing managed code with a backup. Active configurations and data are excluded.");
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const backup = `${STATE_DIR}/backups/${id}`;
  const transaction = { version: 1, id, status: "pending", before, after, changes };
  for (const change of changes) {
    if (!same(readFile(root, change.path), change.before)) throw new Error(`Local file changed during download: ${change.path}`);
    if (change.before) writeFile(root, `${backup}/${change.path}`, originals.get(change.path));
  }
  writeJson(root, `${backup}/transaction.json`, transaction);
  writeJson(root, JOURNAL, transaction);
  log(`Code backup: ${path.join(root, backup)}`);
  try {
    for (const change of changes) {
      if (!same(readFile(root, change.path), change.before)) throw new Error(`Local file changed during update: ${change.path}`);
      if (change.after) writeFile(root, change.path, incoming.get(change.path).bytes, change.after.mode);
      else removeFile(root, change.path);
      log(`[ ${change.action.toUpperCase()} ] ${change.path}`);
    }
    for (const name of names) {
      if (!same(readFile(root, name), incoming.get(name) || null)) throw new Error(`Code verification failed after replacement: ${name}`);
    }
    writeJson(root, MANIFEST, after);
    transaction.status = "complete";
    writeJson(root, JOURNAL, transaction);
  } catch (error) {
    try { restore(root, transaction, config, log); }
    catch (rollbackError) {
      throw new Error(`Code update failed: ${error.message}. Rollback could not finish: ${rollbackError.message}. Keep services stopped. Backup: ${path.join(root, backup)}`);
    }
    throw new Error(`Code update failed and was rolled back: ${error.message}`);
  }
  log(`Code update completed at ${snapshot.commit.slice(0, 12)}: ${summary}`);
  log("Run npm ci --ignore-scripts and npm run doctor before starting services. Runtimes were not updated.");
  return { ...counts, total, commit: snapshot.commit, backup: path.join(root, backup) };
}

module.exports = { updateCode, assertNoPendingUpdate, optionsFrom, createLogger };
