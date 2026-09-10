const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const test = require("node:test");
const download = require("../app/download");
const { withControlLock } = require("../app/control-lock");
const { generatePlaylist } = require("../app/playlist-generator");
const liquidsoap = require("../app/liquidsoap-config");
const metadata = require("../app/metadata-repair");
const { versionIsSupported } = require("../app/doctor");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-audit-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeDownload(context, { body = "new runtime", status = 200, location, error } = {}) {
  context.mock.method(https, "get", (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (failure) => { if (failure) request.emit("error", failure); };
    queueMicrotask(() => {
      if (error) { request.emit("error", new Error(error)); return; }
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = { location };
      callback(response);
    });
    return request;
  });
}

for (const scenario of [
  { name: "network failure", error: "offline", pattern: /offline/ },
  { name: "HTTP failure", status: 503, pattern: /HTTP 503/ },
  { name: "checksum failure", body: "tampered", pattern: /checksum mismatch/ },
  { name: "empty response", body: "", pattern: /empty/ },
  { name: "oversized response", body: "x".repeat(200), maxBytes: 100, pattern: /size limit/ },
  { name: "insecure redirect", status: 302, location: "http://example.invalid/", pattern: /HTTPS/ },
  { name: "redirect loop", status: 302, location: "/again", pattern: /redirect limit/ },
  { name: "malformed redirect", status: 302, location: "https://[", pattern: /Invalid URL/ },
]) test(`failed download preserves cached package: ${scenario.name}`, async (context) => {
  const root = fixture(context);
  const filePath = path.join(root, "runtime.zip");
  fs.writeFileSync(filePath, "old runtime");
  fakeDownload(context, scenario);
  await assert.rejects(download.downloadVerified({ filePath, force: true,
    url: "https://example.invalid/runtime.zip", sha256: "0".repeat(64), maxBytes: scenario.maxBytes }), scenario.pattern);
  assert.equal(fs.readFileSync(filePath, "utf8"), "old runtime");
  assert.deepEqual(fs.readdirSync(root), ["runtime.zip"]);
});

test("verified download replaces cache only after successful validation", async (context) => {
  const root = fixture(context);
  const filePath = path.join(root, "runtime.zip");
  fs.writeFileSync(filePath, "old runtime");
  fakeDownload(context);
  const sha256 = crypto.createHash("sha256").update("new runtime").digest("hex");
  await download.downloadVerified({ filePath, force: true, url: "https://example.invalid/", sha256 });
  assert.equal(fs.readFileSync(filePath, "utf8"), "new runtime");
  assert.equal(download.digestFile(filePath), sha256);
});

test("controller lock excludes concurrent operations and releases after failure", async (context) => {
  const root = fixture(context);
  await assert.rejects(withControlLock(root, async () => {
    await assert.rejects(withControlLock(root, () => assert.fail("concurrent write")), /Another controller operation/);
    throw new Error("failed operation");
  }), /failed operation/);
  assert.deepEqual(fs.readdirSync(root), ["control-locks"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "control-locks")), []);
  assert.equal(await withControlLock(root, () => 42), 42);
});

test("an incomplete lock is not silently deleted or bypassed", async (context) => {
  const root = fixture(context);
  fs.writeFileSync(path.join(root, "control.lock"), "");
  await assert.rejects(withControlLock(root, () => assert.fail("must not run"), { inherited: true }), /confirm both services/);
  assert.equal(fs.existsSync(path.join(root, "control.lock")), true);
});

for (const outputFile of ["server.js", "autodj.config.json", "audio/track.mp3", "sc_serv.conf"]) {
  test(`playlist refuses destructive output: ${outputFile}`, (context) => {
    const root = fixture(context);
    fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({
      playlists: [{ id: "universal", directory: "audio", outputFile }],
    }));
    assert.throws(() => generatePlaylist({ serverRoot: root }), /must be a .lst file/);
  });
}

test("empty libraries cannot erase an existing playable playlist", (context) => {
  const root = fixture(context);
  fs.mkdirSync(path.join(root, "audio"));
  fs.writeFileSync(path.join(root, "universal.lst"), "previous track\n");
  fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({
    playlists: [{ id: "universal", directory: "audio", outputFile: "universal.lst" }],
  }));
  assert.throws(() => generatePlaylist({ serverRoot: root }), /playlist "universal" is empty/);
  assert.equal(fs.readFileSync(path.join(root, "universal.lst"), "utf8"), "previous track\n");
});

test("config rejects misspelled settings and malformed output objects", (context) => {
  const root = fixture(context);
  const configPath = path.join(root, "autodj.config.json");
  for (const value of [
    { server: { password: "test", pasword: "ignored" } },
    { normalization: { enable: true } },
    { crossFadeSeconds: 8 },
    { outputs: [null] },
    { outputs: ["main"] },
  ]) {
    fs.writeFileSync(configPath, JSON.stringify(value));
    assert.throws(() => liquidsoap.loadConfig({ autodjRoot: root }), /Unknown|must be a JSON object/);
  }
});

test("configuration cannot inject station HTTP headers", () => {
  const value = structuredClone(liquidsoap.DEFAULT_CONFIG);
  value.server.password = "test-secret";
  value.server.name = "Radio\r\nInjected: value";
  assert.throws(() => liquidsoap.validateConfig(value), /control characters/);
});

test("playlist CLI rejects a missing option value before accessing files", () => {
  const cli = require("../app/playlist-cli");
  for (const option of ["--config", "--output", "--playlist-dir"]) {
    assert.throws(() => cli.run([option, "--dry-run"]), /requires a .* path/);
  }
});

test("metadata parser bounds unterminated lines and recovers for the next title", () => {
  const titles = [];
  const parser = metadata.createMetadataLogParser((title) => titles.push(title));
  parser.write("x".repeat(70000));
  parser.write('[RADIO_METADATA:1] "truncated line"\n[RADIO_METADATA:1] "Și tu — Радио 🎵"\n');
  parser.end();
  assert.deepEqual(titles, ["Și tu — Радио 🎵"]);
});

test("DNAS oversized and unterminated responses are bounded", async () => {
  const config = { baseUrl: new URL("http://127.0.0.1:8000"), streamId: 1 };
  await assert.rejects(metadata.fetchCurrentTitle(config, async () => new Response("x".repeat(70000))), /size limit/);
});

test("metadata timing rejects overflow and trailing garbage", (context) => {
  const root = fixture(context);
  fs.writeFileSync(path.join(root, "sc_serv.conf"), "PortBase=8000\n");
  for (const value of ["2000junk", "2147483648", "1e9", "-1"]) {
    assert.throws(() => metadata.loadMetadataConfig(root, { RADIO_METADATA_INTERVAL_MS: value }), /positive integer/);
  }
});

test("production preflight accepts Node.js 22 or newer", () => {
  for (const version of ["v18.20.0", "v20.20.2", "garbage", "v24.19"]) {
    assert.equal(versionIsSupported(version), false, version);
  }
  for (const version of ["v22.0.0", "v23.0.0", "v24.19.0", "v26.0.0"]) assert.equal(versionIsSupported(version), true, version);
});

test("doctor detects DNAS source mismatches without exposing passwords", () => {
  const { validateSourceLink } = require("../app/doctor");
  const runtime = { server: { port: 8000, password: "private-source-password" },
    outputs: [{ enabled: true, streamId: 7 }] };
  const valid = "PortBase=8000\nrequirestreamconfigs=1\nstreamid_2=7\nstreampassword_2=private-source-password\n";
  assert.doesNotThrow(() => validateSourceLink(valid, runtime));
  for (const text of [valid.replace("8000", "65535"), valid.replace("8000", "9000"),
    valid.replace("streamid_2=7", "streamid_2=8"), valid.replace("private-source-password", "different-password")]) {
    assert.throws(() => validateSourceLink(text, runtime), (error) => {
      assert.doesNotMatch(error.message, /private-source-password|different-password/);
      return true;
    });
  }
});

test("an installed dpkg package cannot claim a separate OPAM executable", () => {
  const { debianPackageOwnsBinary } = require("../app/dependencies");
  assert.equal(debianPackageOwnsBinary(process.execPath, () => ({ status: 1, stdout: "" })), false);
  assert.equal(debianPackageOwnsBinary(process.execPath, () => ({ status: 0, stdout: "other: /usr/bin/liquidsoap" })), false);
  assert.equal(debianPackageOwnsBinary(process.execPath, () => ({ status: 0, stdout: "liquidsoap:amd64: /usr/bin/liquidsoap" })), true);
});

test("only repository SHOUTcast binaries are marked as managed", (context) => {
  const root = fixture(context);
  const binary = path.join(root, "sc_serv.exe");
  fs.writeFileSync(binary, "fixture executable");
  const resolved = require("../app/platform").resolveShoutcastBinary(root,
    { family: "windows", architecture: "x64", id: "windows-x64" }, { PATH: "" });
  assert.equal(resolved.path, binary);
  assert.equal(resolved.source, "external");
});

test("an OS upgrade does not request dependencies from the previous distribution release", (context) => {
  const root = fixture(context);
  const runtime = path.join(root, "bin", "liquidsoap", "linux-x64");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "runtime.json"), JSON.stringify({
    url: "https://github.com/savonet/liquidsoap-release-assets/releases/download/v2.2.5/liquidsoap_2.2.5-ubuntu-jammy-1_amd64.deb",
  }));
  assert.doesNotThrow(() => require("../app/dependencies").preflightInstall({
    serverRoot: root,
    runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" },
    existingBinary: { found: true, source: "platform" }, debianFamily: true,
    osRelease: { distribution: "ubuntu", codename: "noble" },
    dependencyStatus: { missing: ["liquidsoap"], nativeLibraries: {
      missing: ["libtag.so.1"], abiError: false, debianDepends: "old-jammy-library",
    } },
  }));
});

test("invalid platform settings produce a concise CLI error, not an uncaught stack", () => {
  const result = require("node:child_process").spawnSync(process.execPath,
    [path.resolve(__dirname, "../server.js"), "start"], {
      encoding: "utf8", env: { ...process.env, RADIO_PLATFORM: "invalid-system" }, windowsHide: true,
    });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RadioServer error: Invalid RADIO_PLATFORM/);
  assert.doesNotMatch(result.stderr, /at Module\./);
});

test("published Unicode titles discard invalid XML control characters", () => {
  assert.equal(metadata.normalisePublishedTitle("Și\0tu\u001b — Радио 🎵\ufffe"), "Și tu — Радио 🎵");
});
