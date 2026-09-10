const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { parseVersion, versionIsSupported, getConfig, start, runForeground } = require("../app/autodj-manager");
const { prepareRuntime } = require("../app/autodj-manager");
const metadataRepair = require("../app/metadata-repair");
const realMetadataPublisher = metadataRepair.startMetadataPublisher;
const processState = require("../app/process-state");
const logRotation = require("../app/log-rotation");
const { DEFAULT_CONFIG } = require("../app/liquidsoap-config");

function runtimeFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-autodj-logs-"));
  const config = {
    ...getConfig(root),
    autodjRoot: root, binaryPath: process.execPath,
    runDirectory: path.join(root, ".run"), logDirectory: path.join(root, "logs"),
    pidPath: path.join(root, ".run", "autodj.pid"),
    scriptPath: path.join(root, ".run", "autodj.liq"),
    logPath: path.join(root, "logs", "autodj.log"),
  };
  fs.mkdirSync(config.logDirectory);
  fs.mkdirSync(config.runDirectory);
  fs.mkdirSync(path.join(root, "playlists", "universal"), { recursive: true });
  fs.writeFileSync(path.join(root, "playlists", "universal", "track.mp3"), "test-audio");
  fs.writeFileSync(config.configPath, JSON.stringify({ server: { password: "test-secret" } }));
  fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({
    playlists: [{ id: "universal", directory: "playlists/universal", outputFile: "playlists/universal.lst" }],
  }));
  fs.writeFileSync(config.logPath, "Previous session\n");
  context.mock.method(console, "log", () => {});
  context.mock.method(processState, "inspect", () => ({ fingerprint: "test-start-time", command: [process.execPath, path.join(root, "autodj.js")] }));
  context.mock.method(childProcess, "spawnSync", (binary, args) => ({
    status: 0, stdout: args.includes("--version") ? "Liquidsoap 2.2.5" : "", stderr: "",
  }));
  context.mock.method(metadataRepair, "startMetadataPublisher", () => ({ publish() {}, stop() {} }));
  context.mock.method(metadataRepair, "startMetadataRepair", () => ({ stop() {} }));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const originalListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  const originalExitCode = process.exitCode;
  const originalManagedLog = process.env.RADIO_AUTODJ_BACKGROUND;
  delete process.env.RADIO_AUTODJ_BACKGROUND;
  const logStreams = [];
  const createSessionLog = logRotation.createSessionLog;
  context.mock.method(logRotation, "createSessionLog", (...args) => {
    const stream = createSessionLog(...args);
    logStreams.push(stream);
    return stream;
  });
  context.after(async () => {
    for (const stream of logStreams) {
      if (!stream.closed) {
        const closed = once(stream, "close");
        stream.end();
        await closed;
      }
    }
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!originalListeners.get(signal).includes(listener)) process.removeListener(signal, listener);
      }
    }
    process.exitCode = originalExitCode;
    if (originalManagedLog === undefined) delete process.env.RADIO_AUTODJ_BACKGROUND;
    else process.env.RADIO_AUTODJ_BACKGROUND = originalManagedLog;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const child = new EventEmitter();
  child.pid = 2147483647;
  child.unref = () => {};
  child.kill = () => true;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const spawn = context.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return { config, child, spawn, logStreams };
}

test("parses current Liquidsoap version output", () => {
  assert.deepEqual(parseVersion("Liquidsoap 2.4.5\nCopyright"), [2, 4, 5]);
});

test("requires Liquidsoap 2.2.5 or newer", () => {
  assert.equal(versionIsSupported([2, 2, 4]), false);
  assert.equal(versionIsSupported([2, 2, 5]), true);
  assert.equal(versionIsSupported([2, 4, 5]), true);
  assert.equal(versionIsSupported([3, 0, 0]), true);
});

test("background start leaves logging to the supervisor without a fixed inherited log descriptor", async (context) => {
  const { config } = runtimeFixture(context);
  context.mock.method(childProcess, "spawn", (binary, args, options) => {
    assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(options.env.RADIO_AUTODJ_BACKGROUND, "1");
    const child = new EventEmitter();
    child.pid = 2147483647;
    child.unref = () => {};
    queueMicrotask(() => child.emit("message", { type: "radioserver:ready" }));
    return child;
  });
  await start(config);
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "Previous session\n");
  assert.equal(fs.existsSync(path.join(config.logDirectory, "autodj_1.log")), false);
});

test("the background supervisor owns one fresh rotating log", async (context) => {
  const { config, child, logStreams } = runtimeFixture(context);
  process.env.RADIO_AUTODJ_BACKGROUND = "1";
  fs.writeFileSync(config.pidPath, `${process.pid}\n`);
  await runForeground(config);
  const closed = once(logStreams[0], "close");
  child.stdout.end("Background engine output\n");
  child.stderr.end();
  await once(child.stdout, "end");
  child.emit("close", 0, null);
  await closed;
  assert.equal(logStreams.length, 1);
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "Background engine output\n");
  assert.equal(fs.readFileSync(path.join(config.logDirectory, "autodj_1.log"), "utf8"), "Previous session\n");
});

test("foreground rotation keeps stderr after stdout ends and drains output before closing", async (context) => {
  const { config, child, logStreams } = runtimeFixture(context);
  await runForeground(config);
  const stdoutEnded = once(child.stdout, "end");
  child.stdout.end("AutoDJ test stdout\n");
  await stdoutEnded;
  child.emit("exit", 0, null);
  const stderrEnded = once(child.stderr, "end");
  child.stderr.end("AutoDJ test stderr after exit\n");
  await stderrEnded;
  const logClosed = once(logStreams[0], "close");
  child.emit("close", 0, null);
  await logClosed;
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "AutoDJ test stdout\nAutoDJ test stderr after exit\n");
  assert.equal(fs.readFileSync(path.join(config.logDirectory, "autodj_1.log"), "utf8"), "Previous session\n");
});

test("an AutoDJ console error stops the engine and is retained in its log", async (context) => {
  const { config, child, logStreams } = runtimeFixture(context);
  child.exitCode = null;
  child.signalCode = null;
  context.after(() => child.emit("close", 0, null));
  const initial = process.stderr.listeners("error");
  const kill = context.mock.method(child, "kill", () => true);
  await runForeground(config);
  const handler = process.stderr.listeners("error").find((listener) => listener.name === "outputError" && !initial.includes(listener));
  assert.equal(typeof handler, "function");
  handler(Object.assign(new Error("test console failure"), { code: "EIO" }));
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [["SIGTERM"]]);
  assert.equal(process.exitCode, 1);
  child.stdout.end();
  child.stderr.end();
  const closed = once(logStreams[0], "close");
  child.emit("close", 0, null);
  await closed;
  assert.equal(process.exitCode, 1);
  assert.equal(fs.existsSync(config.pidPath), false);
  assert.match(fs.readFileSync(config.logPath, "utf8"), /console output error: test console failure/);
  assert.deepEqual(process.stderr.listeners("error"), initial);
});

test("invalid runtime validation leaves the current log untouched in both start modes", async (context) => {
  const { config, spawn } = runtimeFixture(context);
  fs.writeFileSync(config.configPath, "{}");
  await assert.rejects(start(config), /example password/);
  await assert.rejects(runForeground(config), /example password/);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "Previous session\n");
  assert.equal(fs.existsSync(path.join(config.logDirectory, "autodj_1.log")), false);
});

test("starting an already-running AutoDJ leaves its live log untouched", async (context) => {
  const { config, spawn } = runtimeFixture(context);
  fs.writeFileSync(config.pidPath, "2147483647\n");
  context.mock.method(process, "kill", () => true);
  await start(config);
  await runForeground(config);
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "Previous session\n");
  assert.equal(fs.existsSync(path.join(config.logDirectory, "autodj_1.log")), false);
});

test("a failed background spawn retains the old log without rotation", async (context) => {
  const { config } = runtimeFixture(context);
  context.mock.method(childProcess, "spawn", () => {
    throw new Error("Test spawn failure");
  });
  await assert.rejects(start(config), /Test spawn failure/);
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "Previous session\n");
  assert.equal(fs.existsSync(path.join(config.logDirectory, "autodj_1.log")), false);
});

test("foreground metadata diagnostics reach the session log and optional repair cannot disable publishing", async (context) => {
  const { config, child, logStreams } = runtimeFixture(context);
  const titles = [];
  context.mock.method(console, "warn", () => {});
  context.mock.method(metadataRepair, "startMetadataPublisher", ({ logger }) => {
    logger.log("[METADATA] Using configured DNAS endpoint");
    return { publish: (title) => titles.push(title), stop() {} };
  });
  context.mock.method(metadataRepair, "startMetadataRepair", () => { throw new Error("Test repair failure"); });
  await runForeground(config);
  const ended = once(child.stdout, "end");
  child.stdout.end('[RADIO_METADATA:1] "Și tu"\n');
  await ended;
  child.stderr.end();
  const closed = once(logStreams[0], "close");
  child.emit("close", 0, null);
  await closed;
  const log = fs.readFileSync(config.logPath, "utf8");
  assert.match(log, /Using configured DNAS endpoint/);
  assert.match(log, /Unicode repair could not start: Test repair failure/);
  assert.deepEqual(titles, ["Și tu"]);
});

test("the supervisor routes and restores distinct stream titles without broadcasting events", async (context) => {
  const { config, child, logStreams } = runtimeFixture(context);
  fs.mkdirSync(path.join(config.serverRoot, "playlists", "pop"));
  fs.writeFileSync(path.join(config.serverRoot, "playlists", "pop", "song.mp3"), "test-audio");
  fs.writeFileSync(path.join(config.serverRoot, "sc_serv.conf"), "PortBase=8000\nadminpassword=test-admin\n");
  fs.writeFileSync(path.join(config.serverRoot, "playlist.config.json"), JSON.stringify({
    playlists: ["universal", "pop"].map((id) => ({ id, directory: `playlists/${id}`, outputFile: `playlists/${id}.lst` })),
  }));
  fs.writeFileSync(config.configPath, JSON.stringify({
    server: { password: "test-source" },
    outputs: [["universal"], ["pop"], []].map((playlists, index) => ({
      ...DEFAULT_CONFIG.outputs[0], id: `output_${index}`, streamId: index + 1, playlists,
    })),
  }));
  const reconciles = [];
  context.mock.method(globalThis, "setInterval", (callback) => {
    reconciles.push(callback);
    return { unref() {} };
  });
  const remoteTitles = new Map();
  const updates = [];
  const publishers = [];
  context.mock.method(metadataRepair, "startMetadataPublisher", (options) => {
    assert.equal(options.streamIds.length, 1);
    const publisher = realMetadataPublisher({
      ...options, environment: {}, retryDelaysMs: [],
      fetchImplementation: async (url) => {
        const id = Number(url.searchParams.get("sid"));
        if (url.pathname === "/currentsong") return new Response(remoteTitles.get(id) || "");
        const title = url.searchParams.get("song");
        updates.push({ id, title });
        remoteTitles.set(id, title);
        return new Response("Metadata updated");
      },
    });
    publishers.push(publisher);
    context.after(() => publisher.stop());
    return publisher;
  });
  await runForeground(config);
  assert.equal(publishers.length, 3);
  const firstTitles = new Map([[1, "Știință"], [2, "Радио"], [3, "Universal 🎵"]]);
  for (const [id, title] of firstTitles) child.stdout.write(`[RADIO_METADATA:${id}] ${JSON.stringify(title)}\n`);
  child.stdout.write('[RADIO_METADATA:99] "Wrong stream"\n[RADIO_METADATA] "No stream"\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(remoteTitles, firstTitles);
  assert.equal(updates.length, 3);

  remoteTitles.clear();
  await Promise.all(reconciles.map((reconcile) => reconcile()));
  assert.deepEqual(remoteTitles, firstTitles);
  assert.equal(updates.length, 6);
  child.stderr.write('[RADIO_METADATA:2] "Melodie nouă"\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 7);
  assert.deepEqual(updates.at(-1), { id: 2, title: "Melodie nouă" });
  assert.equal(remoteTitles.get(1), firstTitles.get(1));
  assert.equal(remoteTitles.get(3), firstTitles.get(3));

  const ended = once(child.stdout, "end");
  child.stdout.end();
  child.stderr.end();
  await ended;
  const closed = once(logStreams[0], "close");
  child.emit("close", 0, null);
  await closed;
  for (const publisher of publishers) assert.equal(publisher.publish("After shutdown"), false);
});

test("invalid output playlist references preserve active playlists, script and session log", (context) => {
  const { config } = runtimeFixture(context);
  const playlist = path.join(config.serverRoot, "playlists", "universal.lst");
  fs.writeFileSync(playlist, "active playlist\n");
  fs.writeFileSync(config.scriptPath, "active script\n");
  fs.writeFileSync(config.configPath, JSON.stringify({
    server: { password: "test-source" },
    outputs: [{ ...DEFAULT_CONFIG.outputs[0], playlists: ["missing"] }],
  }));
  for (const validationOnly of [true, false]) {
    assert.throws(() => prepareRuntime(config, { validationOnly }), /unknown or disabled playlist "missing"/);
    assert.equal(fs.readFileSync(playlist, "utf8"), "active playlist\n");
    assert.equal(fs.readFileSync(config.scriptPath, "utf8"), "active script\n");
    assert.equal(fs.readFileSync(config.logPath, "utf8"), "Previous session\n");
  }
});

test("doctor validation never replaces active playlists, scripts or logs", (context) => {
  const { config } = runtimeFixture(context);
  const playlist = path.join(config.serverRoot, "playlists", "universal.lst");
  fs.writeFileSync(playlist, "active playlist\n");
  fs.writeFileSync(config.scriptPath, "active script\n");
  const result = prepareRuntime(config, { validationOnly: true });
  assert.equal(result.playlist.totalTracks, 1);
  assert.equal(fs.readFileSync(playlist, "utf8"), "active playlist\n");
  assert.equal(fs.readFileSync(config.scriptPath, "utf8"), "active script\n");
  assert.equal(fs.readFileSync(config.logPath, "utf8"), "Previous session\n");
  assert.equal(fs.existsSync(result.scriptPath), false);
});

test("async AutoDJ spawn errors reject start without a success message or invalid PID", async (context) => {
  const { config, child } = runtimeFixture(context);
  child.pid = undefined;
  context.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" })));
    return child;
  });
  await assert.rejects(start(config), /spawn EACCES/);
  assert.equal(fs.existsSync(config.pidPath), false);
  assert.equal(console.log.mock.callCount(), 0);
});

test("rejected Liquidsoap configuration preserves active script and playlists", (context) => {
  const { config } = runtimeFixture(context);
  const playlist = path.join(config.serverRoot, "playlists", "universal.lst");
  fs.writeFileSync(playlist, "previous playlist\n");
  fs.writeFileSync(config.scriptPath, "previous script\n");
  context.mock.method(childProcess, "spawnSync", (binary, args) => args.includes("--version")
    ? { status: 0, stdout: "Liquidsoap 2.2.5" } : { status: 1, stderr: "test rejection" });
  assert.throws(() => prepareRuntime(config), /test rejection/);
  assert.equal(fs.readFileSync(playlist, "utf8"), "previous playlist\n");
  assert.equal(fs.readFileSync(config.scriptPath, "utf8"), "previous script\n");
});

test("Liquidsoap diagnostics redact the source password", (context) => {
  const { config } = runtimeFixture(context);
  context.mock.method(childProcess, "spawnSync", (binary, args) => args.includes("--version")
    ? { status: 0, stdout: "Liquidsoap 2.2.5" } : { status: 1, stderr: 'error near password="test-secret"' });
  assert.throws(() => prepareRuntime(config), (error) => {
    assert.match(error.message, /\[REDACTED\]/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});

test("background readiness failure stops a recorded supervisor and engine", async (context) => {
  const { config, child } = runtimeFixture(context);
  const spawn = childProcess.spawn;
  context.mock.method(childProcess, "spawn", (...args) => {
    const result = spawn(...args);
    processState.save(config, child.pid, "autodj", { childPid: child.pid - 1 });
    return result;
  });
  context.mock.method(processState, "waitForReady", async () => { throw new Error("test readiness timeout"); });
  const stop = context.mock.method(processState, "stop", async () => {
    processState.remove(config, child.pid);
    return true;
  });
  await assert.rejects(start(config), /test readiness timeout/);
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(fs.existsSync(config.pidPath), false);
});
