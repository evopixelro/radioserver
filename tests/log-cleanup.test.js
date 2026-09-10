const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assertLogSeparation, clearLogs, radioLogPaths } = require("../app/log-cleanup");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-clear-logs-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name) => path.join(root, name);
  return { root, file };
}

test("clear empties only the requested active logs and preserves archives and other components", (context) => {
  const { file } = fixture(context);
  for (const name of ["autodj.log", "autodj_1.log", "sc_serv.log"]) fs.writeFileSync(file(name), name);
  assert.equal(clearLogs([file("autodj.log"), file("autodj.log")], { label: "AutoDJ", running: false }), 1);
  assert.equal(fs.readFileSync(file("autodj.log"), "utf8"), "");
  assert.equal(fs.readFileSync(file("autodj_1.log"), "utf8"), "autodj_1.log");
  assert.equal(fs.readFileSync(file("sc_serv.log"), "utf8"), "sc_serv.log");
});

test("clear refuses running services before changing any file", (context) => {
  const { file } = fixture(context);
  fs.writeFileSync(file("autodj.log"), "Live log");
  assert.throws(() => clearLogs([file("autodj.log")], { label: "AutoDJ", running: true }), /Stop AutoDJ/);
  assert.equal(fs.readFileSync(file("autodj.log"), "utf8"), "Live log");
});

test("clear validates every target before truncating and cannot clear configs", (context) => {
  const { file } = fixture(context);
  fs.writeFileSync(file("autodj.log"), "Keep log");
  fs.writeFileSync(file("sc_serv.conf"), "Keep config");
  assert.throws(() => clearLogs([file("autodj.log"), file("sc_serv.conf")], { running: false }), /without a .log extension/);
  assert.equal(fs.readFileSync(file("autodj.log"), "utf8"), "Keep log");
  assert.equal(fs.readFileSync(file("sc_serv.conf"), "utf8"), "Keep config");
});

test("clear rejects linked files and directories", (context) => {
  const { file } = fixture(context);
  fs.writeFileSync(file("original.log"), "Keep linked data");
  fs.linkSync(file("original.log"), file("linked.log"));
  fs.mkdirSync(file("directory.log"));
  for (const target of ["linked.log", "directory.log"]) {
    assert.throws(() => clearLogs([file(target)], { running: false }), /linked or non-regular/);
  }
  assert.equal(fs.readFileSync(file("original.log"), "utf8"), "Keep linked data");
});

test("clear does not create missing logs", (context) => {
  const { root, file } = fixture(context);
  assert.equal(clearLogs([file("missing.log")], { running: false }), 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("SHOUTcast log paths come only from its own captures and native logging settings", (context) => {
  const { root, file } = fixture(context);
  const config = { serverRoot: root, configPath: file("sc_serv.conf"), stdoutLogPath: file("stdout.log"), stderrLogPath: file("stderr.log") };
  fs.writeFileSync(config.configPath, "logfile=native.log\nw3clog=access.log\nstreamw3clog_2=stream2.log\nbanfile=control.ban\n;logfile=ignored.log\n");
  assert.deepEqual(radioLogPaths(config), ["stdout.log", "stderr.log", "native.log", "access.log", "stream2.log"].map(file));
});

function logConfig(root, file) {
  return { serverRoot: root, logDirectory: root, configPath: file("sc_serv.conf"), stdoutLogPath: file("stdout.log"), stderrLogPath: file("stderr.log") };
}

for (const target of ["autodj.log", "autodj_1.log", "stdout.log", "stdout_2.log", "stderr.log"]) {
  test(`rejects a native log overlapping ${target} before clearing or rotating anything`, (context) => {
    const { root, file } = fixture(context);
    const config = logConfig(root, file);
    fs.writeFileSync(config.configPath, `logfile=${target}\n`);
    fs.writeFileSync(file(target), "Keep this log");
    assert.throws(() => assertLogSeparation(config), /Log paths overlap/);
    assert.equal(fs.readFileSync(file(target), "utf8"), "Keep this log");
  });
}

test("rejects hard links to another component's log", (context) => {
  const { root, file } = fixture(context);
  const config = logConfig(root, file);
  fs.writeFileSync(file("autodj.log"), "Live AutoDJ");
  fs.linkSync(file("autodj.log"), file("native.log"));
  fs.writeFileSync(config.configPath, "w3clog=native.log\n");
  assert.throws(() => assertLogSeparation(config), /Log paths overlap/);
});

test("rejects parent-directory aliases even before the log exists", (context) => {
  const { root, file } = fixture(context);
  fs.mkdirSync(file("actual"));
  fs.symlinkSync(file("actual"), file("alias"), process.platform === "win32" ? "junction" : "dir");
  const config = logConfig(root, file);
  fs.writeFileSync(config.configPath, "streamw3clog_2=alias/autodj.log\n");
  assert.throws(() => assertLogSeparation(config, file("actual/autodj.log")), /Log paths overlap/);
  assert.equal(fs.existsSync(file("actual/autodj.log")), false);
});

test("allows separate directories and unrelated log families", (context) => {
  const { root, file } = fixture(context);
  const config = logConfig(root, file);
  fs.writeFileSync(config.configPath, "logfile=native/autodj.log\nw3clog=autodj_extra.log\n");
  assert.equal(assertLogSeparation(config).length, 4);
});

test("Windows and macOS log collision checks are case insensitive", { skip: !["win32", "darwin"].includes(process.platform) }, (context) => {
  const { root, file } = fixture(context);
  const config = logConfig(root, file);
  fs.writeFileSync(config.configPath, "logfile=AUTODJ_1.LOG\n");
  assert.throws(() => assertLogSeparation(config), /Log paths overlap/);
});
