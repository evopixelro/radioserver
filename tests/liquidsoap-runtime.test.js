const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const test = require("node:test");
const { DEFAULT_CONFIG, generateScript } = require("../app/liquidsoap-config");
const { getArguments, checkRuntime } = require("../app/liquidsoap-runtime");
const { createMetadataLogParser } = require("../app/metadata-repair");

const binary = process.env.LIQUIDSOAP_TEST_BIN;

test("Liquidsoap accepts the generated output and evaluates nullable Unicode titles", {
  skip: !binary && "Set LIQUIDSOAP_TEST_BIN to run the real Liquidsoap interpreter",
  timeout: 60000,
}, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-liquidsoap-test-"));
  try {
    const playlistPath = path.join(temporaryRoot, "universal.lst");
    fs.writeFileSync(playlistPath, "");
    const config = {
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, password: "test-only-password" },
      playlistSources: [{ id: "universal", playlistPath, weight: 1 }],
    };
    const script = generateScript(config);
    const checks = [
      'assert(not null.defined(radio_icy_song([])))',
      'assert(not null.defined(radio_icy_song([("song", "Unknown track")])))',
      'assert(null.get(radio_icy_song([("artist", "Știință"), ("title", "Радио")])) == "Știință - Радио")',
      'assert(null.get(radio_icy_song([("song", "Și tu — Музыка")])) == "Și tu — Музыка")',
      'assert(list.mem("title", settings.encoder.metadata.export()))',
      'assert(null.get(radio_icy_song(radio_metadata([("song", "Și tu — Музыка")]))) == "Și tu — Музыка")',
      'assert(null.get(radio_icy_song([("artist", "-"), ("title", "."), ("filename", "/tracks/Melodie.mp3")])) == "Melodie")',
      'print("RADIO_RUNTIME_TEST_OK")',
      "",
    ].join("\n");
    const scriptPath = path.join(temporaryRoot, "validation.liq");
    fs.writeFileSync(scriptPath, script + checks, "utf8");
    const result = spawnSync(binary, getArguments(binary, ["--check", scriptPath]), {
      encoding: "utf8", timeout: 45000, cwd: temporaryRoot, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    // Newer runtimes type-check without evaluating top-level assertions
    const definitionsEnd = script.indexOf("\ndef program_0_track(m) =");
    assert.ok(definitionsEnd > 0);
    const assertionsPath = path.join(temporaryRoot, "assertions.liq");
    fs.writeFileSync(assertionsPath, script.slice(0, definitionsEnd) + "\n" + checks + "exit(0)\n", "utf8");
    const evaluated = spawnSync(binary, getArguments(binary, [assertionsPath]), {
      encoding: "utf8", timeout: 45000, cwd: temporaryRoot, windowsHide: true,
    });
    assert.ifError(evaluated.error);
    assert.equal(evaluated.status, 0, `${evaluated.stdout}\n${evaluated.stderr}`);
    assert.match(evaluated.stdout, /RADIO_RUNTIME_TEST_OK/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Liquidsoap sends a real UTF-8 title to SHOUTcast and the Node supervisor at default log level", {
  skip: !binary && "Set LIQUIDSOAP_TEST_BIN to run the real Liquidsoap interpreter",
  timeout: 45000,
}, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-stream-test-"));
  const sockets = new Set();
  const wantedTitle = "Și tu — Радио";
  let published = false;
  let detected = false;
  let output = "";
  let child;
  let timer;
  let success;
  let failure;
  const finished = new Promise((resolve, reject) => { success = resolve; failure = reject; });
  const check = () => { if (published && detected) success(); };
  const admin = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.searchParams.get("song") === wantedTitle) published = true;
    response.end("OK");
    check();
  });
  const source = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let accepted = false;
    socket.on("data", (chunk) => {
      if (!accepted && chunk.includes(10)) {
        accepted = true;
        socket.write("OK2\r\nicy-caps:11\r\n\r\n");
      }
    });
  });
  try {
    admin.listen(0, "127.0.0.1");
    await once(admin, "listening");
    const port = admin.address().port;
    source.listen(port + 1, "127.0.0.1");
    await once(source, "listening");
    const wave = Buffer.alloc(44 + 44100 * 4 * 2);
    wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
    wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(44100 * 4, 28);
    wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
    wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    const audio = path.join(temporaryRoot, "track.wav");
    fs.writeFileSync(audio, wave);
    const playlistPath = path.join(temporaryRoot, "universal.lst");
    fs.writeFileSync(playlistPath, `annotate:song=${JSON.stringify(wantedTitle)}:${audio.replaceAll("\\", "/")}\n`, "utf8");
    const scriptPath = path.join(temporaryRoot, "stream.liq");
    fs.writeFileSync(scriptPath, generateScript({
      ...DEFAULT_CONFIG, crossfadeSeconds: 0,
      server: { ...DEFAULT_CONFIG.server, host: "127.0.0.1", port, password: "test-only-password", public: false },
      playlistSources: [{ id: "universal", playlistPath, weight: 1 }],
    }), "utf8");
    let streamingBinary = binary;
    if (process.env.LIQUIDSOAP_TEST_RESOURCES) {
      streamingBinary = path.join(temporaryRoot, "runtime", "usr", "bin", path.basename(binary));
      fs.mkdirSync(path.dirname(streamingBinary), { recursive: true });
      fs.copyFileSync(binary, streamingBinary);
      fs.chmodSync(streamingBinary, 0o755);
      fs.writeFileSync(path.join(temporaryRoot, "runtime", "runtime.json"), "{}");
      fs.cpSync(process.env.LIQUIDSOAP_TEST_RESOURCES, path.join(temporaryRoot, "runtime", "usr", "share", "liquidsoap"), { recursive: true });
    }
    child = spawn(streamingBinary, getArguments(streamingBinary, [scriptPath]), { cwd: temporaryRoot, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      const parser = createMetadataLogParser((title, streamId) => {
        if (streamId === 1 && title === wantedTitle) detected = true;
        check();
      });
      stream.setEncoding("utf8");
      stream.on("data", (text) => {
        output += text;
        parser.write(text);
      });
      stream.on("end", () => parser.end());
    }
    child.on("error", failure);
    child.on("exit", (code) => { if (!published || !detected) failure(new Error(`Liquidsoap exited ${code}: ${output}`)); });
    timer = setTimeout(() => failure(new Error(`No confirmed UTF-8 metadata update: ${output}`)), 25000);
    await finished;
    assert.equal(published, true);
    assert.equal(detected, true);
    assert.doesNotMatch(output, /Failed to convert/);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.pid) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    for (const socket of sockets) socket.destroy();
    source.close(); admin.close(); admin.closeAllConnections();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a relocated executable loads its bundled standard library without a global installation", {
  skip: (!binary || !process.env.LIQUIDSOAP_TEST_RESOURCES) && "Set LIQUIDSOAP_TEST_BIN and LIQUIDSOAP_TEST_RESOURCES",
  timeout: 60000,
}, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-relocated-test-"));
  try {
    const relocated = path.join(temporaryRoot, "usr", "bin", path.basename(binary));
    fs.mkdirSync(path.dirname(relocated), { recursive: true });
    fs.copyFileSync(binary, relocated);
    fs.chmodSync(relocated, 0o755);
    fs.writeFileSync(path.join(temporaryRoot, "runtime.json"), "{}");
    fs.cpSync(process.env.LIQUIDSOAP_TEST_RESOURCES, path.join(temporaryRoot, "usr", "share", "liquidsoap"), { recursive: true });
    const stdlib = path.join(temporaryRoot, "usr", "share", "liquidsoap", "libs", "stdlib.liq");
    assert.deepEqual(getArguments(relocated).slice(0, 2), ["--no-stdlib", stdlib]);
    const check = checkRuntime(relocated);
    assert.equal(check.ok, true, check.detail);
    const result = spawnSync(relocated, getArguments(relocated, ["--check", 'assert(string.length("Și — Радио") > 0)']), {
      encoding: "utf8", timeout: 45000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    // A damaged local library must not fall back to a system installation
    fs.writeFileSync(stdlib, "RADIO_INTENTIONALLY_INVALID_STDLIB(\n");
    assert.equal(checkRuntime(relocated).ok, false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
