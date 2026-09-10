const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { DEFAULT_CONFIG } = require("../app/liquidsoap-config");

const binary = process.env.LIQUIDSOAP_TEST_BIN;

async function checkReconnect(multipleStreams) {
  const address = Object.values(os.networkInterfaces()).flat()
    .find((item) => item.family === "IPv4" && !item.internal)?.address;
  assert.ok(address, "A local non-loopback interface is required for this regression");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-autodj-reconnect-"));
  const title = "Și tu — Радио 🎵";
  const expectedTitles = new Map([[1, title], ...(multipleStreams ? [[2, "Pop — Музыка"], [3, title]] : [])]);
  const sourcePassword = "test-source";
  const adminPassword = "test-admin";
  const sockets = new Set();
  let sourceReady = false;
  let acceptSourceMetadata = true;
  const remoteTitles = new Map();
  const confirmedBySupervisor = new Set();
  let connections = 0;
  let output = "";
  let child;
  let liquidsoapPid;
  const admin = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${address}`);
    const streamId = Number(url.searchParams.get("sid") || 1);
    if (url.pathname === "/currentsong") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(remoteTitles.get(streamId) || "");
    } else if (url.pathname === "/stats") {
      response.end(`<SHOUTCASTSERVER><SONGTITLE>${remoteTitles.get(streamId) || ""}</SONGTITLE></SHOUTCASTSERVER>`);
    } else if (url.pathname === "/admin.cgi") {
      const password = url.searchParams.get("pass");
      if (![sourcePassword, adminPassword].includes(password)) {
        response.writeHead(401);
        response.end("Invalid password");
      } else if (!sourceReady) {
        response.end("Metadata update rejected as the stream does not exist");
      } else if (password === sourcePassword && !acceptSourceMetadata) {
        response.end("OK");
      } else {
        remoteTitles.set(streamId, url.searchParams.get("song") || "");
        if (password === adminPassword) confirmedBySupervisor.add(streamId);
        response.end("Metadata updated");
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const source = net.createServer((socket) => {
    sockets.add(socket);
    connections += 1;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let accepted = false;
    socket.on("data", (chunk) => {
      if (!accepted && chunk.includes(10)) {
        accepted = true;
        sourceReady = true;
        socket.write("OK2\r\nicy-caps:11\r\n\r\n");
      }
    });
  });
  const waitFor = async (predicate, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      assert.equal(child?.exitCode ?? null, null, output);
      assert.ok(Date.now() < deadline, `${description}\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const stopServer = async () => {
    sourceReady = false;
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => source.close(resolve)),
      new Promise((resolve) => { admin.close(resolve); admin.closeAllConnections(); }),
    ]);
  };
  try {
    let port;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      admin.listen(0, address);
      await once(admin, "listening");
      port = admin.address().port;
      try {
        source.listen(port + 1, address);
        await once(source, "listening");
        break;
      } catch (error) {
        await stopServer();
        // The OS may reserve the adjacent port even when PortBase is available
        if (attempt === 19 || !["EACCES", "EADDRINUSE", "ERR_SOCKET_BAD_PORT"].includes(error.code)) throw error;
      }
    }
    fs.mkdirSync(path.join(root, "playlists", "universal"), { recursive: true });
    const wave = Buffer.alloc(44 + 44100 * 4 * 120);
    wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
    wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(44100 * 4, 28);
    wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
    wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    fs.writeFileSync(path.join(root, "playlists", "universal", `${title}.wav`), wave);
    const playlistIds = multipleStreams ? ["universal", "pop"] : ["universal"];
    if (multipleStreams) {
      fs.mkdirSync(path.join(root, "playlists", "pop"));
      fs.writeFileSync(path.join(root, "playlists", "pop", `${expectedTitles.get(2)}.wav`), wave);
    }
    fs.writeFileSync(path.join(root, "autodj.config.json"), JSON.stringify({
      ...DEFAULT_CONFIG, playlistMode: "normal",
      server: { ...DEFAULT_CONFIG.server, host: address, port, password: sourcePassword, public: false },
      outputs: (multipleStreams ? [["universal"], ["pop"], []] : [[]]).map((playlists, index) => ({
        ...DEFAULT_CONFIG.outputs[0], id: `output_${index}`, streamId: index + 1, playlists,
      })),
    }));
    fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({
      playlists: playlistIds.map((id) => ({ id, directory: `playlists/${id}`, outputFile: `playlists/${id}.lst` })),
    }));
    fs.writeFileSync(path.join(root, "sc_serv.conf"),
      `PortBase=${port}\ndestip=${address}\nstreamid_1=1\nadminpassword=${adminPassword}\n`);
    const environment = {
      ...process.env, LIQUIDSOAP_BIN: binary, AUTODJ_ROOT: root,
      RADIO_RUN_DIR: path.join(root, ".run"), RADIO_LOG_DIR: path.join(root, "logs"),
      SC_SERV_CONFIG: path.join(root, "sc_serv.conf"), RADIO_METADATA_INTERVAL_MS: "250",
    };
    for (const key of ["RADIO_DNAS_URL", "RADIO_DNAS_PORT", "RADIO_ADMIN_PASSWORD", "RADIO_AUTODJ_BACKGROUND", "RADIO_METADATA_REPAIR"])
      delete environment[key];
    child = spawn(process.execPath, ["-e",
      'const cp=require("node:child_process");const spawn=cp.spawn;cp.spawn=(...args)=>{const c=spawn(...args);process.send({liquidsoapPid:c.pid});return c;};const m=require(process.argv[1]);m.runForeground(m.getConfig(process.argv[2]));process.disconnect();',
      path.resolve(__dirname, "../app/autodj-manager.js"), root,
    ], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    child.on("message", (message) => { liquidsoapPid = message.liquidsoapPid; });
    child.once("error", (error) => { output += error.message; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const titlesMatch = () => [...expectedTitles].every(([id, expected]) => remoteTitles.get(id) === expected);
    await waitFor(titlesMatch, "Initial stream titles are missing or mixed", 30000);
    await stopServer();
    // Lose source metadata after restart so recovery must come from the supervisor
    acceptSourceMetadata = false;
    remoteTitles.clear();
    confirmedBySupervisor.clear();
    await new Promise((resolve) => setTimeout(resolve, 500));
    admin.listen(port, address);
    await once(admin, "listening");
    source.listen(port + 1, address);
    await once(source, "listening");
    await waitFor(() => connections >= expectedTitles.size * 2, "Liquidsoap did not reconnect");
    await waitFor(() => titlesMatch() && [...expectedTitles.keys()].every((id) => confirmedBySupervisor.has(id)),
      "The original titles were not restored to their own streams after restart");
    for (const [id, expected] of expectedTitles) {
      const response = await fetch(`http://${address}:${port}/stats?sid=${id}`);
      assert.ok((await response.text()).includes(`<SONGTITLE>${expected}</SONGTITLE>`));
      assert.equal(output.split(`[RADIO_METADATA:${id}]`).length - 1, 1, "No new track should be required");
    }
  } finally {
    if (child?.pid && child.exitCode === null) {
      const closed = once(child, "close");
      if (liquidsoapPid) {
        try { process.kill(liquidsoapPid); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      const deadline = setTimeout(() => child.kill(), 3000);
      await closed;
      clearTimeout(deadline);
    }
    await stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const multipleStreams of [false, true]) {
  test(`the real AutoDJ supervisor restores ${multipleStreams ? "independent stream titles" : "the same track"} after a destip-bound DNAS restart`, {
    skip: !binary && "Set LIQUIDSOAP_TEST_BIN to test real AutoDJ reconnection",
    timeout: 60000,
  }, () => checkReconnect(multipleStreams));
}
