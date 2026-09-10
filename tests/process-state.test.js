const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const state = require("../app/process-state");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-process-state-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { serverRoot: root, pidPath: path.join(root, "test.pid"), binaryPath: process.execPath };
}

for (const platform of ["darwin", "freebsd"]) {
  test(`${platform} ps keeps process identity and full commands with spaces`, () => {
    const command = "/opt/Radio Server/bin/sc_serv /opt/Radio Server/sc_serv.conf";
    const info = state.inspect(5678, true, { platform, run: (binary, args, options) => {
      assert.equal(binary, "ps");
      assert.deepEqual(args, ["-ww", "-p", "5678", "-o", "stat=", "-o", "lstart=", "-o", "command="]);
      assert.equal(options.env.LC_ALL, "C");
      return { status: 0, stdout: ` Ss  Thu Sep 10 07:24:38 2026 ${command}\n` };
    } });
    assert.deepEqual(info, { fingerprint: "Thu Sep 10 07:24:38 2026", command });
  });

  test(`${platform} ps treats zombie and missing processes as stopped`, () => {
    for (const result of [
      { status: 0, stdout: "Z+ Thu Sep 10 07:24:38 2026 <defunct>\n" },
      { status: 0, stdout: "Z - <defunct>\n" },
      { status: 1, stdout: "", stderr: "" },
      { status: 0, stdout: "\n", stderr: "" },
    ]) assert.equal(state.inspect(5678, false, { platform, run: () => result }), null);
  });

  test(`${platform} ps inspection errors cannot be mistaken for a stopped process`, () => {
    for (const result of [
      { status: 1, stdout: "", stderr: "ps: permission denied" },
      { status: 2, stdout: "", stderr: "" },
      { status: null, signal: "SIGTERM", stdout: "" },
      { error: new Error("spawn ps ENOENT") },
      { status: 0, stdout: "unrecognized output" },
    ]) assert.throws(() => state.inspect(5678, false, { platform, run: () => result }), /Could not/);
  });
}

test("PID records reject malformed or dangerous PID values", (context) => {
  const config = fixture(context);
  for (const value of ["1", "0", "-1", "42junk", "null", "{}", "9007199254740993"]) {
    fs.writeFileSync(config.pidPath, value);
    assert.equal(state.read(config), null, value);
  }
});

test("a reused PID cannot stop an unrelated process", async (context) => {
  const config = fixture(context);
  const inspect = context.mock.method(state, "inspect", () => ({ fingerprint: "original", command: [] }));
  const kill = context.mock.method(process, "kill", () => { throw new Error("must not signal an unrelated process"); });
  state.save(config, 5678, "autodj");
  inspect.mock.mockImplementation(() => ({ fingerprint: "reused", command: [] }));
  assert.equal(await state.stop(config, "autodj"), false);
  assert.equal(kill.mock.callCount(), 0);
});

test("an old numeric PID requires the expected command, not only process existence", async (context) => {
  const config = fixture(context);
  fs.writeFileSync(config.pidPath, "5678\n");
  context.mock.method(state, "inspect", () => ({ fingerprint: "time", command: [process.execPath, path.join(config.serverRoot, "other.js")] }));
  const kill = context.mock.method(process, "kill", () => { throw new Error("must not signal"); });
  assert.equal(await state.stop(config, "autodj"), false);
  assert.equal(kill.mock.callCount(), 0);
});

test("relative Linux commands use the process cwd to validate old PID records", () => {
  const root = path.resolve("radio-example");
  assert.equal(state.commandMatches({ command: [process.execPath, "autodj.js"], cwd: root }, { serverRoot: root }, "autodj"), true);
  assert.equal(state.commandMatches({ command: [process.execPath, "autodj.js"], cwd: path.dirname(root) }, { serverRoot: root }, "autodj"), false);
});

test("stop preserves its PID record when termination cannot be confirmed", async (context) => {
  const config = fixture(context);
  context.mock.method(state, "inspect", () => ({ fingerprint: "original", command: [] }));
  const kill = context.mock.method(process, "kill", () => {});
  state.save(config, 5678, "shoutcast");
  await assert.rejects(state.stop(config, "shoutcast", { timeoutMs: 0, forceTimeoutMs: 0 }), /did not stop/);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments[1]), ["SIGTERM", "SIGKILL"]);
  assert.equal(state.read(config).pid, 5678);
});

test("an exiting process cannot remove another session's PID record", (context) => {
  const config = fixture(context);
  fs.writeFileSync(config.pidPath, "5678\n");
  state.remove(config, 1234);
  assert.equal(state.read(config).pid, 5678);
});

test("real failed spawn rejects asynchronously without writing a PID", async () => {
  const child = spawn(process.execPath, ["--version"], { cwd: path.join(os.tmpdir(), `radio-nonexistent-${process.pid}-${Date.now()}`) });
  await assert.rejects(state.waitForSpawn(child), { code: "ENOENT" });
  assert.equal(child.pid, undefined);
});

test("real startup rejects a child exit within the requested grace period", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(2)"], { stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await assert.rejects(state.waitForSpawn(child, 5000), /exited during startup/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});

test("the default startup grace period rejects exits before its deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter();
  child.pid = 5678;
  const pending = state.waitForSpawn(child);
  child.emit("spawn");
  context.mock.timers.tick(499);
  child.emit("exit", 2, null);
  await assert.rejects(pending, /exited during startup/);
  context.mock.timers.tick(1);
  assert.deepEqual(child.eventNames(), []);
});

test("AutoDJ waits for an explicit supervisor readiness message", async () => {
  const child = new EventEmitter();
  child.pid = 5678;
  const ready = state.waitForReady(child, 1000);
  child.emit("message", { type: "unrelated" });
  child.emit("message", { type: "radioserver:ready" });
  assert.equal(await ready, 5678);
  const failing = new EventEmitter();
  const failed = state.waitForReady(failing, 1000);
  failing.emit("exit", 1, null);
  await assert.rejects(failed, /Supervisor exited during startup/);
});

test("real process identity can be recorded and verified on this host", (context) => {
  const config = fixture(context);
  state.save(config, process.pid, "shoutcast");
  assert.deepEqual(state.status(config, "shoutcast"), { running: true, pid: process.pid });
  assert.deepEqual(state.status(config, "autodj"), { running: false, pid: null });
});

test("an orphaned engine remains identifiable without signaling a reused supervisor PID", async (context) => {
  const config = fixture(context);
  let engineAlive = true;
  const inspect = context.mock.method(state, "inspect", (pid) => ({ fingerprint: pid === 5678 ? "supervisor" : "engine" }));
  state.save(config, 5678, "autodj", { childPid: 6789 });
  inspect.mock.mockImplementation((pid) => pid === 5678 ? { fingerprint: "unrelated" } : engineAlive ? { fingerprint: "engine" } : null);
  assert.deepEqual(state.status(config, "autodj"), { running: true, pid: 6789 });
  const kill = context.mock.method(process, "kill", (pid) => { assert.equal(pid, 6789); engineAlive = false; });
  assert.equal(await state.stop(config, "autodj"), true);
  assert.equal(kill.mock.callCount(), 1);
  assert.equal(fs.existsSync(config.pidPath), false);
});

test("changing the executable cannot hide an already-running server", (context) => {
  const config = fixture(context);
  context.mock.method(state, "inspect", () => ({ fingerprint: "original" }));
  state.save(config, 5678, "shoutcast");
  config.binaryPath = path.join(config.serverRoot, "other-binary");
  assert.throws(() => state.status(config, "shoutcast"), /different runtime path/);
  assert.equal(state.read(config).pid, 5678);
});

for (const parent of [null, { fingerprint: "reused-parent" }]) {
  test(`changing the executable cannot hide an orphan with a ${parent ? "reused" : "missing"} supervisor PID`, async (context) => {
    const config = fixture(context);
    const inspect = context.mock.method(state, "inspect", (pid) => ({ fingerprint: `original-${pid}` }));
    state.save(config, 5678, "shoutcast", { childPid: 6789 });
    inspect.mock.mockImplementation((pid) => pid === 5678 ? parent : { fingerprint: "original-6789" });
    const kill = context.mock.method(process, "kill", () => assert.fail("must not signal after a path change"));
    config.binaryPath = path.join(config.serverRoot, "other-binary");
    assert.throws(() => state.status(config, "shoutcast"), /different runtime path/);
    await assert.rejects(state.stop(config, "shoutcast"), /different runtime path/);
    assert.equal(state.read(config).child.pid, 6789);
    assert.equal(kill.mock.callCount(), 0);
    assert.deepEqual(state.status(config, "autodj"), { running: false, pid: null });
    inspect.mock.mockImplementation(() => ({ fingerprint: "reused" }));
    assert.deepEqual(state.status(config, "shoutcast"), { running: false, pid: null });
  });
}
