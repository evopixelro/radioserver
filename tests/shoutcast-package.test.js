const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getPackage, installShoutcast, LICENSE_URL } = require("../app/shoutcast-package");
const download = require("../app/download");
const platform = require("../app/platform");

function licenseFixture(context) {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-license-test-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  context.mock.method(console, "log", () => {});
  context.mock.method(platform, "resolveProfile", () => ({ id: "linux-x64", family: "linux", architecture: "x64" }));
  context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: false }));
  const downloadMock = context.mock.method(download, "downloadCurrent", async () => {
    throw new Error("TEST_DOWNLOAD_REACHED");
  });
  return {
    serverRoot,
    licensePath: path.join(serverRoot, "bin", "shoutcast", "license.json"),
    downloadMock,
  };
}

test("selects official latest SHOUTcast downloads for supported platforms", () => {
  for (const id of ["linux-x64", "linux-x86", "windows-x64", "windows-x86"]) {
    const [family, architecture] = id.split("-");
    const packageInfo = getPackage({ family, architecture, id });
    assert.match(packageInfo.url, /^https:\/\/download\.nullsoft\.com\//);
    assert.match(packageInfo.url, /-latest\.(tar\.gz|exe)$/);
    assert.match(packageInfo.fileName, /-latest\./);
    assert.match(packageInfo.filePath, /bin[\\/]downloads[\\/]shoutcast/);
  }
});

test("does not invent a current SHOUTcast package for macOS or FreeBSD", () => {
  assert.equal(getPackage({ family: "macos", architecture: "arm64", id: "macos-arm64" }), null);
  assert.equal(getPackage({ family: "freebsd", architecture: "x64", id: "freebsd-x64" }), null);
});

for (const family of ["macos", "freebsd"]) {
  for (const source of ["platform", "PATH", "SC_SERV_BIN"]) {
    for (const force of [false, true]) {
      test(`${family} ${force ? "update" : "install"} preserves a supplied SHOUTcast from ${source}`, async (context) => {
        const profile = { family, architecture: "x64", id: `${family}-x64` };
        const binary = `/radio/bin/shoutcast/${profile.id}/sc_serv`;
        context.mock.method(console, "log", () => {});
        context.mock.method(platform, "resolveProfile", () => profile);
        context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: true, path: binary, source }));
        const fetching = context.mock.method(download, "downloadCurrent", () => assert.fail("must not download a replacement"));
        assert.equal(await installShoutcast({ force }), binary);
        assert.equal(fetching.mock.callCount(), 0);
      });
    }
  }
}

test("records explicit license acceptance and reuses it for install and update", async (context) => {
  const { serverRoot, licensePath, downloadMock } = licenseFixture(context);
  await assert.rejects(installShoutcast({ serverRoot, acceptLicense: true }), /TEST_DOWNLOAD_REACHED/);
  const saved = JSON.parse(fs.readFileSync(licensePath, "utf8"));
  assert.equal(saved.accepted, true);
  assert.equal(saved.licenseUrl, LICENSE_URL);
  assert.ok(Number.isFinite(Date.parse(saved.acceptedAt)));
  await assert.rejects(installShoutcast({ serverRoot }), /TEST_DOWNLOAD_REACHED/);
  await assert.rejects(installShoutcast({ serverRoot, force: true }), /TEST_DOWNLOAD_REACHED/);
  assert.equal(downloadMock.mock.callCount(), 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(licensePath, "utf8")), saved);
});

test("missing acceptance explains the npm commands without downloading", async (context) => {
  const { serverRoot, licensePath, downloadMock } = licenseFixture(context);
  await assert.rejects(installShoutcast({ serverRoot, force: true }), (error) => {
    assert.match(error.message, /npm run install/);
    assert.match(error.message, /npm run update/);
    assert.match(error.message, /already include --accept-license/);
    return true;
  });
  assert.equal(downloadMock.mock.callCount(), 0);
  assert.equal(fs.existsSync(licensePath), false);
});

test("invalid or unrelated license records do not imply consent", async (context) => {
  const { serverRoot, licensePath, downloadMock } = licenseFixture(context);
  fs.mkdirSync(path.dirname(licensePath), { recursive: true });
  for (const contents of [
    "{invalid", "null", "{}",
    JSON.stringify({ accepted: false, licenseUrl: LICENSE_URL }),
    JSON.stringify({ accepted: true, licenseUrl: "https://example.com/unrelated-license" }),
  ]) {
    fs.writeFileSync(licensePath, contents);
    await assert.rejects(installShoutcast({ serverRoot }), /acceptance is not recorded/);
  }
  assert.equal(downloadMock.mock.callCount(), 0);
  await assert.rejects(installShoutcast({ serverRoot, acceptLicense: true }), /TEST_DOWNLOAD_REACHED/);
  assert.equal(JSON.parse(fs.readFileSync(licensePath, "utf8")).accepted, true);
});
