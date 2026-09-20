const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanupDownloadCache, managedDirectory, readCleanupManifest } = require("../app/runtime-cleanup");

function fixture(context) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "radio-cleanup-")));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    context.mock.method(console, "log", () => {});
    context.mock.method(console, "warn", () => {});
    return root;
}

test("managed directory checks allow a project alias but reject redirected children", (context) => {
    const root = fixture(context);
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, "bin", "downloads"), { recursive: true });
    const alias = path.join(root, "alias");
    fs.symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(managedDirectory(alias, "bin", "downloads"), path.join(project, "bin", "downloads"));
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, "bin", "downloads", "liquidsoap"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => managedDirectory(alias, "bin", "downloads", "liquidsoap"), /redirected/);
    for (const part of ["..", ".", "a/b", "a\\b", ""]) assert.throws(() => managedDirectory(project, part), /Invalid/);
});

test("download cleanup removes only known regular files and empty cache directories", (context) => {
    const root = fixture(context);
    const directory = path.join(root, "bin", "downloads", "liquidsoap");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "managed.zip"), "archive");
    fs.writeFileSync(path.join(directory, "notes.txt"), "keep");
    fs.mkdirSync(path.join(directory, "directory.zip"));
    cleanupDownloadCache(root, "Liquidsoap", /\.zip$/);
    assert.equal(fs.existsSync(path.join(directory, "managed.zip")), false);
    assert.equal(fs.readFileSync(path.join(directory, "notes.txt"), "utf8"), "keep");
    assert.ok(fs.statSync(path.join(directory, "directory.zip")).isDirectory());
    fs.unlinkSync(path.join(directory, "notes.txt"));
    fs.rmdirSync(path.join(directory, "directory.zip"));
    cleanupDownloadCache(root, "Liquidsoap", /\.zip$/);
    assert.equal(fs.existsSync(path.dirname(directory)), false);
});

test("download cleanup cannot follow a redirected cache or remove an unknown component", (context) => {
    const root = fixture(context);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "managed.zip"), "keep");
    fs.mkdirSync(path.join(root, "bin", "downloads"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "bin", "downloads", "liquidsoap"), process.platform === "win32" ? "junction" : "dir");
    cleanupDownloadCache(root, "Liquidsoap", /\.zip$/);
    cleanupDownloadCache(root, "../outside", /\.zip$/);
    assert.equal(fs.readFileSync(path.join(outside, "managed.zip"), "utf8"), "keep");
    assert.equal(console.warn.mock.callCount(), 2);
});

test("cleanup manifests reject shared files and malformed data", (context) => {
    const root = fixture(context);
    const file = path.join(root, "runtime.json");
    for (const content of ["null", "[]", "{invalid"]) {
        fs.writeFileSync(file, content);
        assert.throws(() => readCleanupManifest(root));
    }
    fs.writeFileSync(file, '{"version":"8.1.2"}');
    assert.equal(readCleanupManifest(root).version, "8.1.2");
    fs.linkSync(file, path.join(root, "shared.json"));
    assert.throws(() => readCleanupManifest(root), /Invalid cleanup manifest/);
});
