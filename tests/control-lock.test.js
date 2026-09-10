const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const crypto = require("node:crypto");
const { withControlLock, beginChildStartup } = require("../app/control-lock");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-lock-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a rapid stop then start waits for cleanup without running operations together", async (context) => {
  const root = fixture(context);
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stopping = withControlLock(root, async () => {
    events.push("stopping");
    await gate;
    events.push("stopped");
  });
  const onWait = context.mock.fn();
  const starting = withControlLock(root, () => { events.push("started"); }, { timeoutMs: 5000, onWait });
  assert.deepEqual(events, ["stopping"]);
  await delay(300);
  assert.deepEqual(events, ["stopping"]);
  release();
  await Promise.all([stopping, starting]);
  assert.deepEqual(events, ["stopping", "stopped", "started"]);
  assert.equal(onWait.mock.callCount(), 1);
  assert.equal(fs.existsSync(path.join(root, "control.lock")), false);
});

test("waiting times out without modifying another operation's lock", async (context) => {
  const root = fixture(context);
  const filePath = path.join(root, "control.lock");
  const content = "incomplete or interrupted operation";
  fs.writeFileSync(filePath, content);
  const action = context.mock.fn();
  const onWait = context.mock.fn();
  await assert.rejects(withControlLock(root, action, { timeoutMs: 30, onWait }), /did not finish within/);
  assert.equal(action.mock.callCount(), 0);
  assert.equal(onWait.mock.callCount(), 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), content);
});

test("real foreground AutoDJ startup queues before touching configuration", { timeout: 20000 }, async (context) => {
  const root = fixture(context);
  const lockPath = path.join(root, "control.lock");
  fs.writeFileSync(lockPath, "fixture operation");
  const child = spawn(process.execPath, ["-e", `
const manager = require(${JSON.stringify(path.resolve(__dirname, "../app/autodj-manager.js"))});
manager.runForeground = async () => console.log('AutoDJ startup reached');
require(${JSON.stringify(path.resolve(__dirname, "../autodj.js"))}).main(['run_autodj'])
  .catch(error => { console.error(error); process.exitCode = 1; });
`], { env: { ...process.env, RADIO_RUN_DIR: root }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "close");
  context.after(async () => { child.kill(); await closed; });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (!output.includes("Waiting for") && Date.now() < deadline && child.exitCode === null) await delay(20);
  assert.match(output, /Waiting for the previous controller operation/);
  assert.doesNotMatch(output, /AutoDJ startup reached/);
  fs.unlinkSync(lockPath);
  const [code, signal] = await closed;
  assert.equal(code, 0, output);
  assert.equal(signal, null, output);
  assert.match(output, /AutoDJ startup reached/);
  assert.doesNotMatch(output, /Another controller operation holds/);
  assert.equal(fs.existsSync(lockPath), false);
});

function abandoned(context, overrides = {}) {
  const root = fixture(context);
  const nonce = crypto.randomUUID();
  const record = { version: 2, pid: 2000000000, fingerprint: "previous-process", nonce, order: nonce,
    ticket: "1", phase: "holding", unsafe: false, operation: "RadioServer start", ...overrides };
  const directory = path.join(root, "control-locks");
  fs.mkdirSync(directory);
  const registration = path.join(directory, `${record.pid}-${record.nonce}.json`);
  const lockPath = path.join(root, "control.lock");
  fs.writeFileSync(lockPath, JSON.stringify(record));
  fs.writeFileSync(registration, JSON.stringify(record));
  return { root, record, registration, lockPath };
}

const selfOnly = (pid) => pid === process.pid ? { fingerprint: "current-process" } : null;

for (const operation of ["RadioServer run", "AutoDJ run_autodj"]) {
  test(`${operation} recovers an abandoned lock before starting`, async (context) => {
    const { root, record, lockPath, registration } = abandoned(context);
    const recovered = context.mock.fn();
    assert.equal(await withControlLock(root, () => {
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).operation, operation);
      return "started";
    }, { operation, inspect: selfOnly, onRecover: recovered }), "started");
    assert.equal(recovered.mock.callCount(), 1);
    assert.equal(recovered.mock.calls[0].arguments[0].pid, record.pid);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(registration), false);
    assert.deepEqual(fs.readdirSync(path.join(root, "control-locks")), []);
  });
}

test("a live owner is never evicted because its operation is old", async (context) => {
  const { root, record, lockPath } = abandoned(context, { startedAt: "2000-01-01", operation: "AutoDJ start" });
  const contents = fs.readFileSync(lockPath, "utf8");
  await assert.rejects(withControlLock(root, () => assert.fail("live owner"), {
    inspect: (pid) => pid === record.pid ? { fingerprint: record.fingerprint } : selfOnly(pid),
  }), /Current operation: AutoDJ start \(PID 2000000000\)/);
  assert.equal(fs.readFileSync(lockPath, "utf8"), contents);
});

test("a reused PID does not keep an abandoned controller lock alive", async (context) => {
  const { root, record } = abandoned(context);
  assert.equal(await withControlLock(root, () => true, {
    inspect: (pid) => pid === record.pid ? { fingerprint: "different-process" } : selfOnly(pid),
  }), true);
});

test("a record unlinked by atomic replacement remains a readable snapshot", async (context) => {
  const { root } = abandoned(context);
  const original = fs.fstatSync;
  context.mock.method(fs, "fstatSync", (...args) => Object.assign(original(...args), { nlink: 0 }));
  assert.equal(await withControlLock(root, () => "recovered", { inspect: selfOnly }), "recovered");
});

test("an identity lookup failure preserves both lock and registration", async (context) => {
  const { root, registration, lockPath } = abandoned(context);
  const content = fs.readFileSync(lockPath, "utf8");
  await assert.rejects(withControlLock(root, () => assert.fail("unknown identity"), {
    inspect: (pid) => { if (pid !== process.pid) throw new Error("identity permission denied"); return selfOnly(pid); },
  }), /identity permission denied/);
  assert.equal(fs.readFileSync(lockPath, "utf8"), content);
  assert.equal(fs.readFileSync(registration, "utf8"), content);
});

test("untracked and corrupt locks are not automatically removed", async (context) => {
  const root = fixture(context);
  const lockPath = path.join(root, "control.lock");
  for (const contents of ["", "{broken", JSON.stringify({ pid: 2000000000, fingerprint: "old", nonce: crypto.randomUUID() })]) {
    fs.writeFileSync(lockPath, contents);
    await assert.rejects(withControlLock(root, () => assert.fail("untracked operation"), { inspect: selfOnly }), /automatic recovery is unavailable/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), contents);
  }
});

test("a dead owner in an unconfirmed spawn window remains fenced off", async (context) => {
  const { root, registration, lockPath } = abandoned(context, { unsafe: true });
  await assert.rejects(withControlLock(root, () => assert.fail("possible orphan"), { inspect: selfOnly }), /Interrupted startup or external tool needs manual verification/);
  assert.equal(fs.existsSync(registration), true);
  assert.equal(fs.existsSync(lockPath), true);
});

test("recovery rereads spawn state after confirming that the owner died", async (context) => {
  const { root, record, registration } = abandoned(context);
  await assert.rejects(withControlLock(root, () => assert.fail("missed a concurrent spawn"), {
    inspect: (pid) => {
      if (pid === process.pid) return selfOnly(pid);
      fs.writeFileSync(registration, JSON.stringify({ ...record, unsafe: true }));
      return null;
    },
  }), /manual verification/);
  assert.equal(JSON.parse(fs.readFileSync(registration, "utf8")).unsafe, true);
});

test("finishing cannot unlink a lock replaced by another owner", async (context) => {
  const root = fixture(context);
  const lockPath = path.join(root, "control.lock");
  const replacement = { pid: 2000000000, fingerprint: "other", nonce: crypto.randomUUID() };
  await withControlLock(root, () => fs.writeFileSync(lockPath, JSON.stringify(replacement)), { inspect: selfOnly });
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacement);
});

test("a normal external-tool failure releases its lock after the action settles", async (context) => {
  const root = fixture(context);
  await assert.rejects(withControlLock(root, async () => { throw new Error("download failed"); }, {
    inspect: selfOnly, recoverable: false, operation: "RadioServer install",
  }), /download failed/);
  assert.equal(fs.existsSync(path.join(root, "control.lock")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "control-locks")), []);
});

test("confirmed child startup releases the fence and waiting calls do not restore an expired nonce", async (context) => {
  const root = fixture(context);
  const original = process.env.RADIO_CONTROL_NONCE;
  let release;
  const first = withControlLock(root, async () => {
    const finish = beginChildStartup();
    await new Promise((resolve) => { release = resolve; });
    finish();
  }, { inspect: selfOnly });
  const second = withControlLock(root, () => {}, { inspect: selfOnly, timeoutMs: 1000 });
  release();
  await Promise.all([first, second]);
  assert.equal(process.env.RADIO_CONTROL_NONCE, original);
  assert.deepEqual(fs.readdirSync(path.join(root, "control-locks")), []);
});

test("unfinished child startup cannot silently release its registration", async (context) => {
  const root = fixture(context);
  await assert.rejects(withControlLock(root, () => { beginChildStartup(); }, { inspect: selfOnly }), /without confirming child startup/);
  assert.equal(fs.existsSync(path.join(root, "control.lock")), true);
  assert.equal(fs.readdirSync(path.join(root, "control-locks")).length, 1);
});

test("Windows retries transient record access without breaking ownership", { skip: process.platform !== "win32" }, async (context) => {
  const root = fixture(context);
  for (const method of ["renameSync", "unlinkSync", "lstatSync", "openSync"]) {
    const original = fs[method];
    let failures = 0;
    context.mock.method(fs, method, (...args) => {
      if (method === "lstatSync" && args[0] === path.join(root, "control-locks")) return original(...args);
      if (method === "openSync" && typeof args[1] !== "number") return original(...args);
      if (failures++ < 2) throw Object.assign(new Error("record is being read"), { code: "EPERM" });
      return original(...args);
    });
  }
  assert.equal(await withControlLock(root, () => "completed", { inspect: selfOnly }), "completed");
  assert.equal(fs.existsSync(path.join(root, "control.lock")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "control-locks")), []);
});

test("persistent Windows access errors cannot bypass the lock or remove another owner", { skip: process.platform !== "win32" }, async (context) => {
  const { root, lockPath, registration } = abandoned(context);
  const contents = fs.readFileSync(lockPath, "utf8");
  context.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); });
  await assert.rejects(withControlLock(root, () => assert.fail("unpublished registration"), { inspect: selfOnly }), /access denied/);
  assert.equal(fs.readFileSync(lockPath, "utf8"), contents);
  assert.equal(fs.readFileSync(registration, "utf8"), contents);
});

const modulePath = path.resolve(__dirname, "../app/control-lock.js");
const queueInspector = `(pid) => { try { process.kill(pid, 0); return { fingerprint: String(pid) }; } catch (error) { if (error.code === 'ESRCH') return null; throw error; } }`;

function worker(context, script, environment = {}) {
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, RADIO_CONTROL_NONCE: "", ...environment }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(child, "close");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return { child, closed, output: () => output };
}

async function message(child) {
  return Promise.race([once(child, "message").then(([value]) => value), once(child, "exit").then(([code]) => { throw new Error(`Worker exited before its message (${code})`); })]);
}

test("simultaneous processes recover one dead owner without overlapping actions", { timeout: 30000 }, async (context) => {
  const root = fixture(context);
  const owner = worker(context, `
const {withControlLock} = require(${JSON.stringify(modulePath)});
withControlLock(${JSON.stringify(root)}, async () => {
  process.send('held'); await new Promise(() => {});
}, {inspect: ${queueInspector}}).catch(error => { console.error(error); process.exitCode=1; process.disconnect(); });
`);
  await message(owner.child);
  owner.child.kill("SIGKILL");
  await owner.closed;
  const contenders = Array.from({ length: 4 }, () => worker(context, `
const fs=require('node:fs');
const {withControlLock} = require(${JSON.stringify(modulePath)});
const active=${JSON.stringify(path.join(root, "active"))};
(async () => {
  for(let i=0; i<4; i++) await withControlLock(${JSON.stringify(root)}, async () => {
    const fd=fs.openSync(active,'wx');
    await new Promise(resolve=>setTimeout(resolve,15));
    fs.closeSync(fd); fs.unlinkSync(active);
  }, {inspect: ${queueInspector}, timeoutMs:10000});
})().catch(error=>{console.error(error); process.exitCode=1;}).finally(()=>process.disconnect());
`));
  for (const contender of contenders) assert.deepEqual(await contender.closed, [0, null], contender.output());
  assert.equal(fs.existsSync(path.join(root, "control.lock")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "control-locks")), []);
});

test("native process fingerprints allow recovery after a controller is killed", { timeout: 30000 }, async (context) => {
  const root = fixture(context);
  const owner = worker(context, `
require(${JSON.stringify(modulePath)}).withControlLock(${JSON.stringify(root)}, async () => {
  process.send('held'); await new Promise(() => {});
}).catch(error=>{console.error(error); process.exitCode=1; process.disconnect();});
`);
  await message(owner.child);
  owner.child.kill("SIGKILL");
  await owner.closed;
  assert.equal(await withControlLock(root, () => "recovered"), "recovered");
});

test("an inherited supervisor cannot turn a missing parent lock into an independent startup", { timeout: 10000 }, async (context) => {
  const root = fixture(context);
  const child = worker(context, `
require(${JSON.stringify(modulePath)}).withControlLock(${JSON.stringify(root)}, () => {
  throw new Error('ACTION_MUST_NOT_RUN');
}, {inherited:true, inspect:${queueInspector}}).catch(error=>console.log(error.message)).finally(()=>process.disconnect());
`, { RADIO_CONTROL_NONCE: crypto.randomUUID() });
  assert.deepEqual(await child.closed, [0, null], child.output());
  assert.match(child.output(), /Startup controller lock is missing/);
  assert.doesNotMatch(child.output(), /ACTION_MUST_NOT_RUN/);
});

test("an inherited startup remains protected after its parent dies", { timeout: 15000 }, async (context) => {
  const root = fixture(context);
  const release = path.join(root, "release-child");
  const done = path.join(root, "child-finished");
  let childPid;
  let childFinished = false;
  context.after(() => {
    if (childPid && !childFinished) {
      try { process.kill(childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  });
  const childScript = `
const fs=require('node:fs');
require(${JSON.stringify(modulePath)}).withControlLock(${JSON.stringify(root)}, async()=>{
  process.send({pid:process.pid});
  while(!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10));
}, {inherited:true, inspect:${queueInspector}, operation:'AutoDJ run'})
.then(()=>fs.writeFileSync(${JSON.stringify(done)},'done'))
.catch(error=>{fs.writeFileSync(${JSON.stringify(done)},error.message); process.exitCode=1;})
.finally(()=>{if(process.connected)process.disconnect();});
`;
  const parent = worker(context, `
require(${JSON.stringify(modulePath)}).withControlLock(${JSON.stringify(root)}, async()=>{
  const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  child.on('message',value=>process.send(value));
  await new Promise(()=>{});
}, {inspect:${queueInspector}, operation:'AutoDJ start'}).catch(error=>{console.error(error);process.exitCode=1;process.disconnect();});
`);
  childPid = (await message(parent.child)).pid;
  assert.equal(fs.readdirSync(path.join(root, "control-locks")).filter((name) => name.startsWith(`${childPid}-`)).length, 1, "child registered before parent exit");
  parent.child.kill("SIGKILL");
  await parent.closed;
  assert.equal(fs.existsSync(done), false, fs.existsSync(done) ? fs.readFileSync(done, "utf8") : "child is still working");
  const inspect = (pid) => {
    try { process.kill(pid, 0); return { fingerprint: String(pid) }; }
    catch (error) { if (error.code === "ESRCH") return null; throw error; }
  };
  assert.ok(inspect(childPid), "delegate process survived parent termination");
  assert.equal(fs.readdirSync(path.join(root, "control-locks")).filter((name) => name.startsWith(`${childPid}-`)).length, 1, "child remains registered");
  await assert.rejects(withControlLock(root, () => assert.fail("delegate still working"), { inspect }), new RegExp(`AutoDJ run \\(PID ${childPid}\\)`));
  fs.writeFileSync(release, "release");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(done) && Date.now() < deadline) await delay(20);
  assert.equal(fs.readFileSync(done, "utf8"), "done");
  childFinished = true;
  assert.equal(await withControlLock(root, () => "recovered", { inspect }), "recovered");
});
