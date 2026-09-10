const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const manager = require("../app/process-manager");
const state = require("../app/process-state");

function fixture(context, script) {
  const base = path.join(__dirname, "..", ".run");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "test-process-"));
  const config = {
    serverRoot: root, runDirectory: root, logDirectory: root,
    binaryPath: process.execPath, runtimeProfile: { family: process.platform === "win32" ? "windows" : "linux", id: "test" },
    configPath: path.join(root, "fixture.js"), pidPath: path.join(root, "test.pid"),
    stdoutLogPath: path.join(root, "stdout.log"), stderrLogPath: path.join(root, "stderr.log"), arguments: [],
  };
  fs.writeFileSync(config.configPath, script);
  context.mock.method(console, "log", () => {});
  context.after(async () => {
    if (fs.existsSync(config.pidPath)) await manager.stop(config);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return config;
}

test("SHOUTcast controller starts, identifies and stops a real isolated fixture process", async (context) => {
  const config = fixture(context, "setInterval(() => {}, 1000)");
  let pid;
  try { pid = await manager.start(config); } catch (error) {
    throw new Error(`${error.message}\n${fs.readFileSync(config.stderrLogPath, "utf8")}`);
  }
  assert.ok(Number.isInteger(pid));
  assert.deepEqual(manager.getStatus(config), { running: true, pid });
  await manager.stop(config);
  assert.equal(manager.getStatus(config).running, false);
  assert.equal(fs.existsSync(config.pidPath), false);
});

test("a real immediate startup failure never reports success or writes a PID", async (context) => {
  const config = fixture(context, "process.stderr.write('test startup failure'); process.exit(2)");
  await assert.rejects(manager.start(config), /exited during startup/);
  assert.equal(fs.existsSync(config.pidPath), false);
  assert.equal(console.log.mock.callCount(), 0);
});

test("SHOUTcast preflight rejects a directory without changing its permissions", (context) => {
  const config = fixture(context, "test configuration");
  config.binaryPath = config.serverRoot;
  config.binarySource = "platform";
  config.runtimeProfile.family = "linux";
  const chmod = context.mock.method(fs, "chmodSync", () => assert.fail("must not chmod a directory"));
  assert.throws(() => manager.prepareRuntime(config), /not executable/);
  assert.equal(chmod.mock.callCount(), 0);
});

test("SHOUTcast launch arguments reject values that cannot be passed to the OS", () => {
  for (const args of [["value\0suffix"], [null], "argument"]) {
    assert.throws(() => manager.getRunConfig({}, args), /arguments must be an array of strings without null characters/);
  }
  assert.deepEqual(manager.getRunConfig({}, ["value with spaces"]).arguments, ["value with spaces"]);
});

test("background SHOUTcast capture rotates both logs without stopping its engine", { timeout: 30000 }, async (context) => {
  const config = fixture(context, `
setTimeout(() => {
  process.stdout.write('o'.repeat(650));
  process.stderr.write('e'.repeat(650));
}, 1200);
setInterval(() => {}, 1000);
`);
  config.logOptions = { maxBytes: 128, maxFiles: 2 };
  const pid = await manager.start(config);
  const deadline = Date.now() + 10000;
  const completed = () => [config.stdoutLogPath, config.stderrLogPath].every((file) => {
    try { return fs.statSync(file).size === 10; } catch { return false; }
  });
  while (!completed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(completed(), "Both captured streams must finish rotating");
  for (const [name, character] of [["stdout", "o"], ["stderr", "e"]]) {
    const files = fs.readdirSync(config.logDirectory).filter((file) => new RegExp(`^${name}(?:_\\d+)?\\.log$`).test(file));
    assert.equal(files.length, 3);
    for (const file of files) assert.ok(fs.statSync(path.join(config.logDirectory, file)).size <= 128);
    assert.equal(fs.readFileSync(path.join(config.logDirectory, `${name}.log`), "utf8"), character.repeat(10));
  }
  assert.deepEqual(manager.getStatus(config), { running: true, pid });
  assert.ok(Number.isInteger(state.read(config).child.pid));
  await manager.stop(config);
  assert.equal(manager.getStatus(config).running, false);
});

test("foreground hangup stops the real engine and cleans its PID before the controller exits", { timeout: 30000 }, async (context) => {
  const config = fixture(context, String.raw`
process.on('SIGHUP', () => process.stdout.write('Log rotation only\n'));
process.on('SIGTERM', () => {
  process.stdout.write('Graceful shutdown\n');
  setTimeout(() => process.exit(0), 100);
});
setInterval(() => {}, 1000);
`);
  // Exercise the real CLI and child process; Windows can only emulate the incoming hangup
  const controller = spawn(process.execPath, ["-e", `
const state = require(${JSON.stringify(path.resolve(__dirname, "../app/process-state.js"))});
const config = require(${JSON.stringify(path.resolve(__dirname, "../app/config.js"))});
Object.assign(config, ${JSON.stringify(config)});
if (process.platform === 'win32') {
  const forward = state.forwardSignals;
  state.forwardSignals = (...args) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      return forward(...args);
    } finally { Object.defineProperty(process, 'platform', platform); }
  };
}
process.once('message', () => {
  process.disconnect();
  process.emit('SIGHUP');
});
require(${JSON.stringify(path.resolve(__dirname, "../server.js"))}).main(['run'])
  .then(() => process.send({ type: 'ready' }))
  .catch(error => { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect(); });
`], { cwd: config.serverRoot, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let output = "";
  controller.stdout.on("data", (chunk) => { output += chunk; });
  controller.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(controller, "close");
  context.after(async () => {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL");
    await closed;
  });
  const ready = await Promise.race([
    once(controller, "message"),
    closed.then(() => { throw new Error(`Controller exited before ready: ${output}`); }),
  ]);
  assert.equal(ready[0].type, "ready");
  const { pid, running } = manager.getStatus(config);
  assert.equal(running, true);
  assert.equal(fs.existsSync(path.join(config.runDirectory, "control.lock")), false);
  if (process.platform === "win32") controller.send("hangup");
  else {
    controller.disconnect();
    controller.kill("SIGHUP");
  }
  const [code, signal] = await closed;
  assert.equal(signal, null, output);
  assert.equal(code, 0, output);
  assert.equal(state.inspect(pid), null);
  assert.equal(fs.existsSync(config.pidPath), false);
  if (process.platform !== "win32") {
    assert.match(fs.readFileSync(config.stdoutLogPath, "utf8"), /Graceful shutdown/);
    assert.doesNotMatch(output, /Log rotation only/);
  }
});

test("a foreground console failure stops the real engine and records an error", { timeout: 30000 }, async (context) => {
  const config = fixture(context, "setInterval(() => {}, 1000)");
  const controller = spawn(process.execPath, ["-e", `
const manager = require(${JSON.stringify(path.resolve(__dirname, "../app/process-manager.js"))});
process.once('message', () => {
  process.disconnect();
  process.stdout.emit('error', Object.assign(new Error('test broken pipe'), { code: 'EPIPE' }));
});
manager.runForeground(${JSON.stringify(config)})
  .then(() => process.send({ type: 'ready' }))
  .catch(error => { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect(); });
`], { cwd: config.serverRoot, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let output = "";
  controller.stdout.on("data", (chunk) => { output += chunk; });
  controller.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(controller, "close");
  context.after(async () => {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL");
    await closed;
  });
  await Promise.race([
    once(controller, "message"),
    closed.then(() => { throw new Error(`Controller exited before ready: ${output}`); }),
  ]);
  const enginePid = state.read(config).child.pid;
  assert.ok(state.inspect(enginePid));
  controller.send("break-output");
  assert.deepEqual(await closed, [1, null], output);
  assert.equal(state.inspect(enginePid), null);
  assert.equal(fs.existsSync(config.pidPath), false);
  assert.match(fs.readFileSync(config.stderrLogPath, "utf8"), /console output error: test broken pipe/);
});
