const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { LogTail, followLogs } = require("../app/log-console");
const { openSessionLog } = require("../app/log-rotation");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-console-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "autodj.log");
  return { root, filePath, tail: new LogTail(filePath) };
}

test("console reads only the recent 50 lines then follows new output once", (context) => {
  const { filePath, tail } = fixture(context);
  fs.writeFileSync(filePath, Array.from({ length: 100 }, (_, index) => `Line ${index}\n`).join(""));
  const text = tail.read();
  assert.equal(text.split("\n").length, 51);
  assert.ok(text.startsWith("Line 50\n"));
  assert.ok(text.endsWith("Line 99\n"));
  assert.equal(tail.read(), "");
  fs.appendFileSync(filePath, "Live output\n");
  assert.equal(tail.read(), "Live output\n");
  assert.equal(tail.read(), "");
});

test("console initial history and live reads stay bounded for huge log lines", (context) => {
  const { filePath, tail } = fixture(context);
  const text = "Ș".repeat(80000);
  fs.writeFileSync(filePath, text);
  const history = tail.read();
  assert.equal(Buffer.byteLength(history), 64 * 1024);
  assert.doesNotMatch(history, /�/);
  fs.appendFileSync(filePath, text);
  assert.equal(Buffer.byteLength(tail.read()), 64 * 1024);
});

test("console preserves UTF-8 characters split between writes", (context) => {
  const { filePath, tail } = fixture(context);
  const bytes = Buffer.from("Și Радио 🎵\n");
  fs.writeFileSync(filePath, bytes.subarray(0, 1));
  let text = tail.read();
  for (const byte of bytes.subarray(1)) {
    fs.appendFileSync(filePath, Buffer.from([byte]));
    text += tail.read();
  }
  assert.equal(text, bytes.toString());
});

test("bounded initial history preserves a pending UTF-8 character on an oversized line", (context) => {
  const { filePath, tail } = fixture(context);
  const bytes = Buffer.from("Ș");
  fs.writeFileSync(filePath, Buffer.concat([Buffer.alloc(70000, 120), bytes.subarray(0, 1)]));
  assert.doesNotMatch(tail.read(), /�/);
  fs.appendFileSync(filePath, bytes.subarray(1));
  assert.equal(tail.read(), "Ș");
});

test("console tracks actual AutoDJ session rotation without locking the old file", (context) => {
  const { filePath, tail } = fixture(context);
  fs.writeFileSync(filePath, "Old session\n");
  assert.equal(tail.read(), "Old session\n");
  const fd = openSessionLog(filePath);
  fs.writeSync(fd, "New session\n");
  fs.closeSync(fd);
  assert.equal(tail.read(), "New session\n");
  assert.equal(fs.readFileSync(filePath.replace(".log", "_1.log"), "utf8"), "Old session\n");
});

test("console detects truncation and same-size or larger in-place replacements", (context) => {
  const { filePath, tail } = fixture(context);
  fs.writeFileSync(filePath, "Previous session\n");
  tail.read();
  for (const value of ["New\n", "Now\n", "Replacement larger than the previous log\n"]) {
    fs.writeFileSync(filePath, value);
    assert.equal(tail.read(), value);
  }
});

test("console waits for missing files without creating files or directories", (context) => {
  const { root, filePath, tail } = fixture(context);
  assert.equal(tail.read(), "");
  assert.deepEqual(fs.readdirSync(root), []);
  fs.writeFileSync(filePath, "Created\n");
  assert.equal(tail.read(), "Created\n");
  fs.unlinkSync(filePath);
  assert.equal(tail.read(), "");
  fs.writeFileSync(filePath, "Recreated\n");
  assert.equal(tail.read(), "Recreated\n");
});

test("console rejects non-file paths and reports permissions instead of silently waiting", (context) => {
  const { root, tail } = fixture(context);
  assert.throws(() => new LogTail(root).read(), /regular log file|EISDIR/);
  context.mock.method(fs, "openSync", () => { throw Object.assign(new Error("Test EACCES"), { code: "EACCES" }); });
  assert.throws(() => tail.read(), /Test EACCES/);
});

test("closing the viewer removes only its own signal handlers and never signals an engine", async (context) => {
  const { filePath } = fixture(context);
  const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signalNames.map((name) => process.listeners(name));
  const kill = context.mock.method(process, "kill", () => assert.fail("console must not kill processes"));
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const controller = new AbortController();
  const following = followLogs([filePath], { label: "AutoDJ", output, signal: controller.signal, intervalMs: 5 });
  await delay(20);
  controller.abort();
  await following;
  assert.match(text, /read-only.*CTRL\+C/);
  assert.match(text, /without stopping AutoDJ/);
  signalNames.forEach((name, index) => assert.deepEqual(process.listeners(name), listeners[index]));
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(kill.mock.callCount(), 0);
});

test("console respects backpressure and can close while output is blocked", async (context) => {
  const { filePath } = fixture(context);
  let writes = 0;
  const output = new Writable({ highWaterMark: 1, write() { writes += 1; } });
  const controller = new AbortController();
  const following = followLogs([filePath], { label: "AutoDJ", output, signal: controller.signal });
  await delay(20);
  assert.equal(writes, 1);
  controller.abort();
  await following;
  assert.equal(output.listenerCount("drain"), 0);
  output.destroy();
});

for (const name of ["SIGINT", "SIGTERM"]) {
  test(`${name} closes only the viewer`, async (context) => {
    const { filePath } = fixture(context);
    const output = new PassThrough();
    output.resume();
    const kill = context.mock.method(process, "kill", () => assert.fail("console must not signal an engine"));
    const following = followLogs([filePath], { label: "AutoDJ", output });
    process.emit(name);
    await following;
    assert.equal(kill.mock.callCount(), 0);
  });
}

for (const code of ["EPIPE", "EIO", "ENOSPC"]) {
  test(`console handles closed or failing output: ${code}`, async (context) => {
    const { filePath } = fixture(context);
    const output = new Writable({ write(chunk, encoding, callback) {
      callback(Object.assign(new Error(`Test ${code}`), { code }));
    } });
    const following = followLogs([filePath], { label: "AutoDJ", output });
    if (code === "ENOSPC") await assert.rejects(following, /Test ENOSPC/);
    else await following;
  });
}

for (const [entryPoint, command, logName, label] of [
  ["server.js", "console", "sc_serv.stdout.log", "RadioServer"],
  ["autodj.js", "console", "autodj.log", "AutoDJ"],
  ["server.js", "console_autodj", "autodj.log", "AutoDJ"],
]) {
  test(`real ${entryPoint} ${command} remains read-only alongside a running engine`, { timeout: 20000 }, async (context) => {
    const { root } = fixture(context);
    const logPath = path.join(root, logName);
    fs.writeFileSync(logPath, "Existing log\n");
    fs.writeFileSync(path.join(root, "control.lock"), "Existing operation");
    const engine = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const engineClosed = once(engine, "close");
    context.after(async () => { engine.kill(); await engineClosed; });
    const child = spawn(process.execPath, [path.resolve(__dirname, "..", entryPoint), command], {
      env: { ...process.env, RADIO_LOG_DIR: root, RADIO_RUN_DIR: root },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const closed = once(child, "close");
    context.after(async () => { child.kill(); await closed; });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const waitFor = async (text) => {
      const deadline = Date.now() + 5000;
      while (!output.includes(text) && Date.now() < deadline && child.exitCode === null) await delay(20);
      assert.ok(output.includes(text), output);
    };
    await waitFor("Existing log");
    assert.ok(output.includes(`${label} console`));
    fs.appendFileSync(logPath, "Live — Și Радио\n");
    await waitFor("Live — Și Радио");
    child.kill("SIGINT");
    await closed;
    assert.equal(engine.exitCode, null);
    assert.equal(engine.signalCode, null);
    assert.equal(fs.readFileSync(path.join(root, "control.lock"), "utf8"), "Existing operation");
    assert.deepEqual(fs.readdirSync(root).sort(), ["control.lock", logName].sort());
  });
}
