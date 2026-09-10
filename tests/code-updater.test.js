const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const source = require("../app/code-update-source");
const updater = require("../app/code-updater");
const radio = require("../app/process-manager");
const autodj = require("../app/autodj-manager");

function file(name, content) {
  const bytes = Buffer.from(content);
  return { path: name, bytes, hash: source.sha256(bytes), mode: 0o644 };
}

function snapshot(overrides = {}, commit = "a".repeat(40)) {
  const root = path.resolve(__dirname, "..");
  const names = fs.readdirSync(root).filter(source.managedPath);
  const files = names.map((name) => file(name, fs.readFileSync(path.join(root, name))));
  files.push(...["app/cli.js", "app/code-updater.js", "app/code-update-source.js", "app/probe.js"].map((name) => file(name, "module.exports = 1;\n")));
  const entries = new Map(files.map((entry) => [entry.path, entry]));
  for (const [name, content] of Object.entries(overrides)) {
    if (content === null) entries.delete(name);
    else entries.set(name, file(name, content));
  }
  return { commit, files: [...entries.values()] };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-code-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(radio, "getStatus", () => ({ running: false }));
  t.mock.method(autodj, "status", () => ({ running: false }));
  const config = {
    serverRoot: root, runDirectory: path.join(root, ".run"), logDirectory: path.join(root, "logs"),
    configPath: path.join(root, "sc_serv.conf"), binaryPath: path.join(root, "bin", "sc_serv"),
    stdoutLogPath: path.join(root, "logs", "sc_serv.stdout.log"), stderrLogPath: path.join(root, "logs", "sc_serv.error.log"),
  };
  const messages = [];
  const write = (name, bytes) => { const location = path.join(root, name); fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, bytes); };
  const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
  const run = (value, args = [], dependencies = {}) => updater.updateCode(config, args, {
    log: (message) => messages.push(message), color: false, downloadSnapshot: async () => value, ...dependencies,
  });
  const seed = (value = snapshot()) => { for (const entry of value.files) write(entry.path, entry.bytes); };
  return { root, config, write, read, run, seed, messages };
}

test("FTP code update reports every change and preserves active configs, data and start scripts", async (t) => {
  const f = fixture(t);
  f.write("server.js", "module.exports = 'previous';\n");
  f.write("app/custom.js", "module.exports = 'local extension';\n");
  const data = ["README.md", "LICENSE", "sc_serv.conf", "autodj.config.json", "bin/liquidsoap", "playlists/universal/song.mp3", "logs/autodj.log", "control/sc_serv.ban", "start", "radioserver", ".run/autodj.pid.test"];
  for (const name of data) f.write(name, name === "sc_serv.conf" ? "PortBase=8000\n" : "local data");
  const value = snapshot();
  const result = await f.run(value);
  assert.equal(result.updated, 1);
  assert.equal(result.added, value.files.length - 1);
  assert.equal(result.total, value.files.length);
  for (const name of data) assert.equal(f.read(name), name === "sc_serv.conf" ? "PortBase=8000\n" : "local data");
  assert.match(f.read("app/custom.js"), /local extension/);
  assert.equal(fs.readFileSync(path.join(result.backup, "server.js"), "utf8"), "module.exports = 'previous';\n");
  assert.ok(f.messages.some((line) => line === "[ UPDATED ] server.js"));
  assert.ok(f.messages.some((line) => line.includes(`${result.total} files changed`)));
  assert.equal(fs.existsSync(path.join(f.root, ".git")), false);
});

test("repeated update skips unchanged files without rewriting their timestamps", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  const before = fs.statSync(path.join(f.root, "server.js")).mtimeMs;
  const result = await f.run(snapshot());
  assert.equal(result.total, 0);
  assert.equal(fs.statSync(path.join(f.root, "server.js")).mtimeMs, before);
  assert.ok(f.messages.includes("[ SKIP ] server.js"));
});

function trackedDocuments(f) {
  const manifest = JSON.parse(f.read(".run/code-update/manifest.json"));
  const journal = JSON.parse(f.read(".run/code-update/transaction.json"));
  for (const name of ["README.md", "LICENSE"]) {
    const entry = { hash: source.sha256(Buffer.from(`downloaded ${name}`)), mode: 0o644 };
    manifest.files[name] = entry;
    journal.after.files[name] = entry;
    journal.changes.push({ path: name, before: null, after: entry, action: "added" });
    f.write(name, `local ${name}`);
  }
  f.write(".run/code-update/manifest.json", JSON.stringify(manifest));
  f.write(".run/code-update/transaction.json", JSON.stringify(journal));
}

test("missing README and LICENSE are not created by an update", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  for (const name of ["README.md", "LICENSE"]) assert.equal(fs.existsSync(path.join(f.root, name)), false);
});

for (const args of [[], ["--force"]]) {
  test(`previously tracked documents remain untouched during update ${args.join(" ")}`, async (t) => {
    const f = fixture(t);
    await f.run(snapshot());
    trackedDocuments(f);
    const modified = fs.statSync(path.join(f.root, "README.md")).mtimeMs;
    fs.unlinkSync(path.join(f.root, "LICENSE"));
    f.messages.length = 0;
    const next = snapshot({ "app/probe.js": "module.exports = 2;\n" }, "b".repeat(40));
    const preview = await f.run(next, ["--check"]);
    assert.equal(preview.total, 1);
    assert.ok(JSON.parse(f.read(".run/code-update/manifest.json")).files["README.md"]);
    const result = await f.run(next, args);
    assert.deepEqual([result.added, result.updated, result.removed], [0, 1, 0]);
    assert.equal(f.read("README.md"), "local README.md");
    assert.equal(fs.statSync(path.join(f.root, "README.md")).mtimeMs, modified);
    assert.equal(fs.existsSync(path.join(f.root, "LICENSE")), false);
    const manifest = JSON.parse(f.read(".run/code-update/manifest.json"));
    for (const name of ["README.md", "LICENSE"]) {
      assert.equal(Object.hasOwn(manifest.files, name), false);
      assert.equal(fs.existsSync(path.join(result.backup, name)), false);
    }
    await f.run(null, ["--rollback"]);
    assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
    assert.equal(f.read("README.md"), "local README.md");
    assert.equal(fs.existsSync(path.join(f.root, "LICENSE")), false);
    assert.ok(f.messages.every((line) => !/^\[ \w+ \] (README\.md|LICENSE)$/.test(line)));
  });
}

test("dropping document tracking without code changes preserves the previous rollback", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n" }, "b".repeat(40)));
  trackedDocuments(f);
  const result = await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n" }, "c".repeat(40)));
  assert.equal(result.total, 0);
  const manifest = JSON.parse(f.read(".run/code-update/manifest.json"));
  assert.equal(manifest.commit, "b".repeat(40));
  assert.equal(Object.hasOwn(manifest.files, "README.md"), false);
  assert.equal(Object.hasOwn(manifest.files, "LICENSE"), false);
  await f.run(null, ["--rollback"]);
  assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
  for (const name of ["README.md", "LICENSE"]) assert.equal(f.read(name), `local ${name}`);
});

for (const status of ["complete", "pending"]) {
  test(`rollback of a ${status} document-tracking transaction preserves local documents`, async (t) => {
    const f = fixture(t);
    await f.run(snapshot());
    trackedDocuments(f);
    const journal = JSON.parse(f.read(".run/code-update/transaction.json"));
    journal.status = status;
    for (const change of journal.changes.filter((entry) => source.preservedDocument(entry.path))) {
      change.before = { hash: source.sha256(Buffer.from("previous document")), mode: 0o644 };
    }
    f.write(".run/code-update/transaction.json", JSON.stringify(journal));
    if (status === "pending") assert.throws(() => updater.assertNoPendingUpdate(f.root), /interrupted/);
    else updater.assertNoPendingUpdate(f.root);
    await f.run(null, ["--rollback"]);
    updater.assertNoPendingUpdate(f.root);
    for (const name of ["README.md", "LICENSE"]) assert.equal(f.read(name), `local ${name}`);
  });
}

test("a commit with unchanged managed code preserves the previous rollback", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n" }, "b".repeat(40)));
  const noChange = await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n" }, "c".repeat(40)));
  assert.equal(noChange.total, 0);
  await f.run(null, ["--rollback"]);
  assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
});

test("later updates add, modify and remove only manifest-owned files with recoverable backups", async (t) => {
  const f = fixture(t);
  await f.run(snapshot({ "app/obsolete.js": "module.exports = 'old';\n" }));
  const result = await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n", "app/new.js": "module.exports = 3;\n" }, "b".repeat(40)));
  assert.deepEqual([result.added, result.updated, result.removed], [1, 1, 1]);
  assert.equal(fs.existsSync(path.join(f.root, "app/obsolete.js")), false);
  assert.match(fs.readFileSync(path.join(result.backup, "app/obsolete.js"), "utf8"), /old/);
  assert.ok(f.messages.includes("[ REMOVED ] app/obsolete.js"));
  await f.run(null, ["--rollback"]);
  assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
  assert.match(f.read("app/obsolete.js"), /old/);
  assert.equal(fs.existsSync(path.join(f.root, "app/new.js")), false);
});

test("local modifications stop the whole update unless --force explicitly replaces them with backups", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  f.write("app/probe.js", "module.exports = 'custom';\n");
  const next = snapshot({ "app/new.js": "module.exports = 5;\n" });
  await assert.rejects(f.run(next), /Local code changes/);
  assert.equal(fs.existsSync(path.join(f.root, "app/new.js")), false);
  const result = await f.run(next, ["--force"]);
  assert.match(fs.readFileSync(path.join(result.backup, "app/probe.js"), "utf8"), /custom/);
});

test("--check does not write files or require the services to be stopped", async (t) => {
  const f = fixture(t);
  t.mock.method(radio, "getStatus", () => ({ running: true }));
  f.seed();
  const result = await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n" }), ["--check"]);
  assert.equal(result.total, 1);
  assert.equal(fs.existsSync(path.join(f.root, ".run")), false);
  assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
});

test("running services and Git checkouts refuse code mutation before any network request", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const downloadSnapshot = async () => { calls += 1; return snapshot(); };
  const status = t.mock.method(radio, "getStatus", () => ({ running: true }));
  await assert.rejects(f.run(null, [], { downloadSnapshot }), /Stop AutoDJ and SHOUTcast/);
  status.mock.restore();
  f.write(".git", "gitdir: elsewhere");
  await assert.rejects(f.run(null, [], { downloadSnapshot }), /Git checkout/);
  assert.equal(calls, 0);
});

test("a service starting during download prevents activation", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(null, [], { downloadSnapshot: async () => {
    t.mock.method(autodj, "status", () => ({ running: true }));
    return snapshot();
  } }), /Stop AutoDJ and SHOUTcast/);
  assert.equal(fs.existsSync(path.join(f.root, "server.js")), false);
});

test("network and validation errors cannot replace code or create an activation journal", async (t) => {
  const f = fixture(t);
  f.seed();
  await assert.rejects(f.run(null, [], { downloadSnapshot: async () => { throw new Error("Download failed"); } }), /Download failed/);
  await assert.rejects(f.run({ commit: "invalid", files: [] }), /Invalid code snapshot/);
  assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
  assert.equal(fs.existsSync(path.join(f.root, ".run/code-update/transaction.json")), false);
});

test("updating code never executes downloaded JavaScript or npm lifecycle scripts", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.root, "downloaded-code-executed");
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');\n`;
  await f.run(snapshot({ "app/probe.js": script }));
  assert.equal(f.read("app/probe.js"), script);
  assert.equal(fs.existsSync(marker), false);
});

test("a failed replacement rolls back all earlier changes", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(f.root, "app/probe.js") && !failed) { failed = true; throw new Error("simulated disk failure"); }
    return rename(from, to);
  });
  await assert.rejects(f.run(snapshot({ "app/cli.js": "module.exports = 5;\n", "app/probe.js": "module.exports = 2;\n" })), /failed and was rolled back/);
  assert.equal(f.read("app/cli.js"), "module.exports = 1;\n");
  assert.equal(f.read("app/probe.js"), "module.exports = 1;\n");
  updater.assertNoPendingUpdate(f.root);
});

test("interrupted rollback blocks startup and can be resumed without network access", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  const rename = fs.renameSync;
  let applying = false;
  const failure = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(f.root, "app/probe.js")) applying = true;
    if (applying && [path.join(f.root, "app/probe.js"), path.join(f.root, "app/cli.js")].includes(to)) throw new Error("disk unavailable");
    return rename(from, to);
  });
  await assert.rejects(f.run(snapshot({ "app/cli.js": "module.exports = 5;\n", "app/probe.js": "module.exports = 2;\n" })), /Rollback could not finish/);
  failure.mock.restore();
  assert.throws(() => updater.assertNoPendingUpdate(f.root), /interrupted/);
  await assert.rejects(f.run(snapshot()), /interrupted/);
  await f.run(null, ["--rollback"], { downloadSnapshot: async () => { throw new Error("network must not be used"); } });
  updater.assertNoPendingUpdate(f.root);
  assert.equal(f.read("app/cli.js"), "module.exports = 1;\n");
});

test("rollback refuses subsequent local edits and corrupted backups", async (t) => {
  const f = fixture(t);
  await f.run(snapshot());
  const result = await f.run(snapshot({ "app/probe.js": "module.exports = 2;\n" }));
  f.write("app/probe.js", "module.exports = 3;\n");
  await assert.rejects(f.run(null, ["--rollback"]), /later local edit/);
  f.write("app/probe.js", "module.exports = 2;\n");
  fs.writeFileSync(path.join(result.backup, "app/probe.js"), "damaged");
  await assert.rejects(f.run(null, ["--rollback"]), /damaged code backup/);
  assert.equal(f.read("app/probe.js"), "module.exports = 2;\n");
});

test("managed files cannot be hardlinks or directories", async (t) => {
  const f = fixture(t);
  f.write("user-data", "important");
  fs.linkSync(path.join(f.root, "user-data"), path.join(f.root, "server.js"));
  await assert.rejects(f.run(snapshot()), /linked/);
  assert.equal(f.read("user-data"), "important");
  fs.unlinkSync(path.join(f.root, "server.js"));
  fs.mkdirSync(path.join(f.root, "server.js"));
  await assert.rejects(f.run(snapshot()), /Invalid or oversized/);
});

test("linked code directories cannot redirect writes outside the deployment", async (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "radio-code-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, "app"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run(snapshot()), /linked/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("linked updater state cannot redirect backups", async (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "radio-code-state-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.root, ".run"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run(snapshot()), /linked/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("corrupt or escaping manifest entries stop updates", async (t) => {
  const f = fixture(t);
  f.write(".run/code-update/manifest.json", "null");
  await assert.rejects(f.run(snapshot()), /Invalid updater state/);
  f.write(".run/code-update/manifest.json", JSON.stringify({ version: 1, repository: source.REPOSITORY, commit: "a".repeat(40), files: { "../outside.js": { hash: "a".repeat(64), mode: 0o644 } } }));
  await assert.rejects(f.run(snapshot()), /Invalid code update manifest entry/);
});

test("custom runtime paths cannot overlap managed code", async (t) => {
  const f = fixture(t);
  f.config.logDirectory = path.join(f.root, "app");
  await assert.rejects(f.run(snapshot()), /Runtime data overlaps/);
  assert.equal(fs.existsSync(path.join(f.root, "server.js")), false);
});

test("unknown or conflicting updater flags fail before any file changes", () => {
  for (const args of [["--unknown"], ["--force", "--force"], ["--rollback", "--force"], ["--rollback", "--check"]]) {
    assert.throws(() => updater.optionsFrom(args), /Usage/);
  }
});

test("update status colors identify skips, changes, removals, conflicts and restores", () => {
  const messages = [];
  const log = updater.createLogger((message) => messages.push(message), true);
  for (const [state, code] of [["SKIP", 90], ["ADDED", 32], ["UPDATED", 32], ["REMOVED", 33], ["RESTORE", 33], ["LOCAL", 31]]) {
    log(`[ ${state} ] app/file.js`);
    assert.equal(messages.at(-1), `[ \u001b[${code}m${state}\u001b[0m ] app/file.js`);
  }
  log("Code update completed.");
  assert.equal(messages.at(-1), "Code update completed.");
  updater.createLogger((message) => messages.push(message), false)("[ UPDATED ] app/file.js");
  assert.equal(messages.at(-1), "[ UPDATED ] app/file.js");
});

test("NO_COLOR disables updater colors without changing the messages", (t) => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "";
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  const messages = [];
  updater.createLogger((message) => messages.push(message))("[ SKIP ] server.js");
  assert.deepEqual(messages, ["[ SKIP ] server.js"]);
});

test("custom DNAS access lists are protected even when placed inside app", async (t) => {
  const f = fixture(t);
  f.write("sc_serv.conf", "banfile=app/access.txt\n");
  f.write("app/access.txt", "local rules");
  await assert.rejects(f.run(snapshot({ "app/access.txt": "remote rules" })), /Runtime data overlaps/);
  assert.equal(f.read("app/access.txt"), "local rules");
});

test("playlist directories remain protected even for disabled playlists", async (t) => {
  const f = fixture(t);
  f.write("playlist.config.json", JSON.stringify({ playlists: [
    { id: "universal", directory: "playlists/universal", outputFile: ".run/universal.lst" },
    { id: "pop", enabled: false, directory: "app", outputFile: ".run/pop.lst" },
  ] }));
  await assert.rejects(f.run(snapshot()), /Runtime data overlaps/);
});
