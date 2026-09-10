const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runDoctor } = require("../app/doctor");
const dependencies = require("../app/dependencies");
const systemDependencies = require("../app/system-dependencies");

test("doctor requests isolated validation and does not require Screen", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-doctor-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "audio"));
  fs.writeFileSync(path.join(root, "sc_serv.conf"), "PortBase=8000\nadminpassword=test-secret\npassword=test-source\n");
  fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({
    playlists: [{ id: "universal", directory: "audio", outputFile: "universal.lst" }],
  }));
  const lines = [];
  context.mock.method(console, "log", (line) => lines.push(line));
  context.mock.method(dependencies, "getDependencyStatus", () => ({ missing: [], detail: "ready" }));
  context.mock.method(systemDependencies, "inspect", () => ({ checked: true, missing: [], abiError: false }));
  let validated = false;
  runDoctor({ serverRoot: root, binaryPath: process.execPath, configPath: path.join(root, "sc_serv.conf"), runtimeProfile: { id: "test" },
    stdoutLogPath: path.join(root, "stdout.log"), stderrLogPath: path.join(root, "stderr.log") }, {
    getConfig: () => ({ serverRoot: root, logPath: path.join(root, "autodj.log") }), findBinary: () => process.execPath,
    loadConfiguration: () => ({ server: { port: 8000, password: "test-source" }, outputs: [{ enabled: true, streamId: 1 }] }),
    prepareRuntime(config, options) {
      assert.equal(config.serverRoot, root);
      assert.deepEqual(options, { validationOnly: true });
      validated = true;
      return {
        playlist: { totalTracks: 1, playlists: [{ id: "universal" }] },
        runtimeConfig: { outputs: [{ enabled: true, streamId: 1 }] },
      };
    },
  });
  assert.equal(validated, true);
  assert.doesNotMatch(lines.join("\n"), /GNU Screen/);
  assert.match(lines.join("\n"), /OK Playlists stream #1: universal/);
});
