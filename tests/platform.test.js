const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  detectProfile,
  resolveLiquidsoapBinary,
  resolveProfile,
  resolveShoutcastBinary,
} = require("../app/platform");

test("normalizes Node.js platform and architecture names", () => {
  assert.deepEqual(detectProfile({ platform: "win32", architecture: "ia32" }), {
    family: "windows",
    architecture: "x86",
    id: "windows-x86",
  });
  assert.deepEqual(detectProfile({ platform: "darwin", architecture: "arm64" }), {
    family: "macos",
    architecture: "arm64",
    id: "macos-arm64",
  });
});

test("auto selection follows the current host", () => {
  assert.equal(
    resolveProfile("auto", { platform: "linux", architecture: "x64" }).id,
    "linux-x64",
  );
  assert.equal(
    resolveProfile("windows", { platform: "win32", architecture: "x64" }).id,
    "windows-x64",
  );
});

test("allows 32-bit SHOUTcast on 64-bit Windows but rejects another OS", () => {
  assert.equal(
    resolveProfile("windows-x86", { platform: "win32", architecture: "x64" }).id,
    "windows-x86",
  );
  assert.throws(
    () => resolveProfile("linux", { platform: "win32", architecture: "x64" }),
    /cannot run on this windows-x64 host/,
  );
});

test("builds deterministic platform-specific runtime paths", () => {
  const serverRoot = path.resolve("C:/radio");
  const environment = { PATH: "" };
  const shoutcast = resolveShoutcastBinary(
    serverRoot,
    { family: "windows", architecture: "x64", id: "windows-x64" },
    environment,
  );
  assert.equal(
    shoutcast.path,
    path.join(serverRoot, "bin", "shoutcast", "windows-x64", "sc_serv.exe"),
  );

  const liquidsoap = resolveLiquidsoapBinary(
    serverRoot,
    { family: "windows", architecture: "x64", id: "windows-x64" },
    environment,
  );
  assert.match(liquidsoap.path, /windows-x64[\\/]liquidsoap\.exe$/);
});

for (const [host, family] of [["linux", "linux"], ["win32", "windows"], ["darwin", "macos"], ["freebsd", "freebsd"]]) {
  test(`${family} selection and binary lookup use the host profile for both components`, () => {
    const root = path.resolve("radio-platform-fixture");
    for (const architecture of ["x64", "arm64"]) {
      const profile = resolveProfile("auto", { platform: host, architecture });
      assert.deepEqual(profile, { family, architecture, id: `${family}-${architecture}` });
      const sc = resolveShoutcastBinary(root, profile, { PATH: "" });
      const autodj = resolveLiquidsoapBinary(root, profile, { PATH: "" });
      assert.equal(sc.found, false);
      assert.equal(autodj.found, false);
      assert.equal(sc.path, path.join(root, "bin", "shoutcast", profile.id, family === "windows" ? "sc_serv.exe" : "sc_serv"));
      // Lookup does not imply a compatible vendor package exists for this architecture
      assert.ok(autodj.candidates.some((candidate) => candidate.startsWith(path.join(root, "bin", "liquidsoap", profile.id))));
    }
    assert.throws(() => resolveProfile(host === "linux" ? "windows" : "linux", { platform: host, architecture: "x64" }), /cannot run/);
  });
}
