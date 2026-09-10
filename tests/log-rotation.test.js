const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { createSessionLog, openSessionLog } = require("../app/log-rotation");

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radio-log-rotation-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    logPath: path.join(directory, "autodj.log"),
    read: (name) => fs.readFileSync(path.join(directory, name), "utf8"),
    write: (name, value) => fs.writeFileSync(path.join(directory, name), value),
  };
}

test("creates a private fresh log and preserves every previous session", (context) => {
  const { directory, logPath, read } = fixture(context);
  for (let session = 1; session <= 12; session += 1) {
    const descriptor = openSessionLog(logPath, { maxFiles: 12 });
    try {
      assert.equal(fs.fstatSync(descriptor).size, 0);
      if (process.platform !== "win32") {
        assert.equal(fs.fstatSync(descriptor).mode & 0o777, 0o640 & ~process.umask());
      }
      fs.writeSync(descriptor, `Sesiune ${session} — Și Радио\n`);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  assert.equal(fs.readdirSync(directory).length, 12);
  assert.equal(read("autodj.log"), "Sesiune 12 — Și Радио\n");
  for (let archive = 1; archive <= 11; archive += 1) {
    assert.equal(read(`autodj_${archive}.log`), `Sesiune ${12 - archive} — Și Радио\n`);
  }
});

test("rotates only exact AutoDJ log names and handles gaps in archive numbering", (context) => {
  const { logPath, read, write } = fixture(context);
  write("autodj.log", "current");
  write("autodj_1.log", "previous");
  write("autodj_3.log", "older");
  const unrelated = ["sc_serv.log", "sc_serv_1.log", "autodj_01.log", "autodj_1.log.backup", "autodj_other.log"];
  for (const name of unrelated) write(name, name);
  fs.closeSync(openSessionLog(logPath));
  assert.equal(read("autodj_1.log"), "current");
  assert.equal(read("autodj_2.log"), "previous");
  assert.equal(read("autodj_4.log"), "older");
  for (const name of unrelated) assert.equal(read(name), name);
});

test("does not shift archives when no current log exists", (context) => {
  const { logPath, read, write } = fixture(context);
  write("autodj_1.log", "previous");
  fs.closeSync(openSessionLog(logPath));
  assert.equal(read("autodj.log"), "");
  assert.equal(read("autodj_1.log"), "previous");
});

test("refuses non-file archive targets before moving any log", (context) => {
  const { directory, logPath, read, write } = fixture(context);
  write("autodj.log", "current");
  write("autodj_1.log", "previous");
  fs.mkdirSync(path.join(directory, "autodj_2.log"));
  assert.throws(() => openSessionLog(logPath), /requires a regular file/);
  assert.equal(read("autodj.log"), "current");
  assert.equal(read("autodj_1.log"), "previous");
});

test("a rotation failure does not truncate the current log", (context) => {
  const { logPath, read, write } = fixture(context);
  write("autodj.log", "current");
  context.mock.method(fs, "renameSync", () => { throw new Error("Test rotation failure"); });
  assert.throws(() => openSessionLog(logPath), /Test rotation failure/);
  assert.equal(read("autodj.log"), "current");
});

test("session retention removes only expired exact AutoDJ archive names", (context) => {
  const { directory, logPath, read, write } = fixture(context);
  write("sc_serv.log", "SHOUTcast");
  write("autodj_1.log.backup", "Unrelated backup");
  for (let index = 0; index < 10; index += 1) {
    const fd = openSessionLog(logPath, { maxFiles: 2 });
    fs.writeSync(fd, String(index));
    fs.closeSync(fd);
  }
  assert.equal(read("autodj.log"), "9");
  assert.equal(read("autodj_1.log"), "8");
  assert.equal(read("autodj_2.log"), "7");
  assert.equal(read("sc_serv.log"), "SHOUTcast");
  assert.equal(read("autodj_1.log.backup"), "Unrelated backup");
  assert.equal(fs.readdirSync(directory).length, 5);
});

for (const name of ["autodj.log", "sc_serv.stdout.log", "sc_serv.error.log"]) {
  test(`${name} rotates during one long-running session and enforces size and retention`, async (context) => {
    const { directory } = fixture(context);
    const log = createSessionLog(path.join(directory, name), { maxBytes: 100, maxFiles: 2 });
    const closed = once(log, "close");
    log.end("x".repeat(450));
    await closed;
    const files = fs.readdirSync(directory);
    assert.equal(files.length, 3);
    for (const file of files) assert.ok(fs.statSync(path.join(directory, file)).size <= 100);
    assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), "x".repeat(50));
  });
}

test("rotation keeps complete Unicode characters and drains large writes in order", async (context) => {
  const { directory, logPath } = fixture(context);
  const wanted = "Șи🎵".repeat(10);
  const log = createSessionLog(logPath, { maxBytes: 13, maxFiles: 20 });
  const closed = once(log, "close");
  log.end(wanted);
  await closed;
  const files = fs.readdirSync(directory).sort((a, b) => Number(b.match(/_(\d+)/)?.[1] || 0) - Number(a.match(/_(\d+)/)?.[1] || 0));
  const content = files.map((file) => {
    const bytes = fs.readFileSync(path.join(directory, file));
    assert.ok(bytes.length <= 13);
    return new TextDecoder("utf8", { fatal: true }).decode(bytes);
  }).join("");
  assert.equal(content, wanted);
});

test("rotation reports an asynchronous write failure and closes its descriptor", async (context) => {
  const { logPath } = fixture(context);
  const log = createSessionLog(logPath);
  let descriptor;
  context.mock.method(fs, "write", (fd, buffer, offset, length, position, callback) => {
    descriptor = fd;
    queueMicrotask(() => callback(Object.assign(new Error("Disk full"), { code: "ENOSPC" })));
  });
  const failed = once(log, "error");
  const closed = new Promise((resolve) => log.once("close", resolve));
  log.write("Test error");
  assert.equal((await failed)[0].code, "ENOSPC");
  await closed;
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
});
