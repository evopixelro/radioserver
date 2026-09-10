const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const test = require("node:test");
const manager = require("../app/autodj-manager");
const state = require("../app/process-state");
const { withControlLock } = require("../app/control-lock");

test("a real background supervisor confirms engine startup and stops its process tree", async (context) => {
  const base = path.join(__dirname, "..", ".run");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "test-autodj-"));
  const variables = {
    LIQUIDSOAP_BIN: process.execPath, AUTODJ_ROOT: root,
    RADIO_RUN_DIR: path.join(root, ".run"), RADIO_LOG_DIR: path.join(root, "logs"),
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  const config = manager.getConfig(root);
  let enginePid;
  context.after(async () => {
    try {
      if (fs.existsSync(config.pidPath)) {
        const record = state.read(config);
        try { await manager.stop(config); } finally {
          if (record && state.inspect(record.pid)?.fingerprint === record.fingerprint) process.kill(record.pid);
        }
      }
    } finally {
      if (enginePid && state.inspect(enginePid)) {
        try { process.kill(enginePid); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(path.join(root, "playlists", "universal"), { recursive: true });
  fs.writeFileSync(path.join(root, "playlists", "universal", "track.mp3"), "fixture audio");
  fs.writeFileSync(config.configPath, JSON.stringify({ server: { password: "test-password" } }));
  fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({
    playlists: [{ id: "universal", directory: "playlists/universal", outputFile: "playlists/universal.lst" }],
  }));
  // Replace only the engine; run the actual supervisor, IPC and OS process controls
  fs.writeFileSync(path.join(root, "autodj.js"), `
const cp = require('node:child_process');
const originalSpawn = cp.spawn;
const originalSync = cp.spawnSync;
cp.spawnSync = (binary, args, options) => binary === process.execPath
  ? { status: 0, stdout: args.includes('--version') ? 'Liquidsoap 2.2.5' : '', stderr: '' }
  : originalSync(binary, args, options);
cp.spawn = (binary, args, options) => originalSpawn(binary,
  binary === process.execPath && args.some(arg => arg.endsWith('autodj.liq'))
    ? ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "engine.pid"))}, String(process.pid)); setInterval(() => {}, 1000)`)}]
    : args, options);
const config = require(${JSON.stringify(path.resolve(__dirname, "../app/config.js"))});
config.serverRoot = __dirname;
require(${JSON.stringify(path.resolve(__dirname, "../app/cli.js"))}).main(['run_autodj']).catch(error => { console.error(error); process.exitCode = 1; });
`);
  const originalSync = cp.spawnSync;
  context.mock.method(cp, "spawnSync", (binary, args, options) => binary === process.execPath
    ? { status: 0, stdout: args.includes("--version") ? "Liquidsoap 2.2.5" : "", stderr: "" }
    : originalSync(binary, args, options));
  context.mock.method(console, "log", () => {});
  const pid = await withControlLock(config.runDirectory, () => manager.start(config));
  assert.deepEqual(manager.status(config), { running: true, pid });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(root, "engine.pid")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  enginePid = Number(fs.readFileSync(path.join(root, "engine.pid"), "utf8"));
  assert.ok(state.inspect(enginePid));
  await manager.stop(config);
  assert.equal(manager.status(config).running, false);
  assert.equal(state.inspect(enginePid), null);
});
