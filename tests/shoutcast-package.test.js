const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getPackage, installShoutcast, LICENSE_URL } = require("../app/shoutcast-package");
const download = require("../app/download");
const platform = require("../app/platform");
const systemDependencies = require("../app/system-dependencies");

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

test("SHOUTcast checks tar and the GNU tar gzip helper only for managed Linux archives", () => {
    const { getInstallRequirements } = require("../app/shoutcast-package");
    const profile = { family: "linux", architecture: "x64", id: "linux-x64" };
    const calls = [];
    const report = getInstallRequirements(profile, { found: false }, { run(command) {
        calls.push(command);
        return { status: command === "tar" ? 0 : 1, stdout: "tar (GNU tar) 1.35" };
    } });
    assert.deepEqual(calls, ["tar", "gzip"]);
    assert.deepEqual(report.missing, ["gzip"]);
    const bsd = getInstallRequirements(profile, { found: false }, { run(command) {
        assert.equal(command, "tar");
        return { status: 0, stdout: "bsdtar 3.7.0 - libarchive" };
    } });
    assert.deepEqual(bsd.missing, []);
    assert.equal(bsd.items.length, 1);
    for (const source of ["PATH", "SC_SERV_BIN", "external"]) {
        assert.deepEqual(getInstallRequirements(profile, { found: true, source }, { run: () => assert.fail("external binary needs no tar") }).items, []);
    }
    for (const id of ["windows-x64", "macos-arm64", "freebsd-x64"]) {
        assert.deepEqual(getInstallRequirements({ id }, { found: false }, { run: () => assert.fail("no managed tar archive") }).items, []);
    }
});

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
            test(`${family} ${force ? "install" : "update"} preserves a supplied SHOUTcast from ${source}`, async (context) => {
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

function installationFixture(context, family = "linux", existing = false) {
    const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-shoutcast-install-"));
    context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
    context.mock.method(console, "log", () => {});
    const warnings = context.mock.method(console, "warn", () => {});
    const profile = { family, architecture: "x64", id: `${family}-x64` };
    const packageInfo = getPackage(profile, serverRoot);
    const directory = path.join(serverRoot, "bin", "shoutcast", profile.id);
    const binary = path.join(directory, family === "windows" ? "sc_serv.exe" : "sc_serv");
    const manifest = path.join(directory, "runtime.json");
    const digest = "a".repeat(64);
    fs.mkdirSync(path.dirname(packageInfo.filePath), { recursive: true });
    if (existing) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(binary, "previous runtime");
        fs.writeFileSync(manifest, JSON.stringify({ sha256: digest }));
    }
    context.mock.method(platform, "resolveProfile", () => profile);
    context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: fs.existsSync(binary), path: binary, source: "platform" }));
    context.mock.method(download, "downloadCurrent", async ({ filePath }) => {
        fs.writeFileSync(filePath, "downloaded official package");
        return digest;
    });
    context.mock.method(systemDependencies, "inspect", () => {
        assert.ok(fs.existsSync(packageInfo.filePath), "keep the download until native validation has completed");
        return { checked: true, libraries: [], missing: [] };
    });
    const run = context.mock.fn((command, args) => {
        assert.ok(fs.existsSync(packageInfo.filePath));
        if (family === "linux") {
            assert.equal(command, "tar");
            fs.writeFileSync(path.join(args[3], "sc_serv"), "new runtime");
        } else {
            assert.equal(command, packageInfo.filePath);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(binary, "new runtime");
        }
        return { status: 0 };
    });
    return { serverRoot, binary, manifest, digest, packageInfo, run, warnings };
}

for (const family of ["linux", "windows"]) {
    for (const force of [false, true]) {
        test(`${family} ${force ? "reinstall" : "first install"} removes SHOUTcast downloads only after successful activation`, async (context) => {
            const f = installationFixture(context, family, force);
            const cache = path.dirname(f.packageInfo.filePath);
            fs.writeFileSync(path.join(cache, "sc_serv2_linux_x64_2_6_1_777.tar.gz"), "old archive");
            fs.writeFileSync(path.join(cache, "sc_serv2_win64-2.6.1.777.exe"), "old installer");
            const result = await installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, force, run: f.run });
            assert.equal(result, f.binary);
            assert.equal(fs.readFileSync(f.binary, "utf8"), "new runtime");
            assert.equal(JSON.parse(fs.readFileSync(f.manifest)).sha256, f.digest);
            assert.equal(fs.existsSync(path.join(f.serverRoot, "bin", "downloads")), false);
            assert.ok(fs.existsSync(path.join(f.serverRoot, "bin", "shoutcast", "license.json")));
            assert.equal(f.warnings.mock.callCount(), 0);
        });
    }
}

test("matching installed SHOUTcast also removes the comparison download without reinstalling", async (context) => {
    const f = installationFixture(context, "linux", true);
    await installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, run: f.run });
    assert.equal(f.run.mock.callCount(), 0);
    assert.equal(fs.readFileSync(f.binary, "utf8"), "previous runtime");
    assert.equal(fs.existsSync(path.dirname(f.packageInfo.filePath)), false);
});

for (const family of ["linux", "windows"]) {
    test(`${family} SHOUTcast update installs a changed official package without forcing reinstall`, async (context) => {
        const f = installationFixture(context, family, true);
        fs.writeFileSync(f.manifest, JSON.stringify({ sha256: "b".repeat(64) }));
        await installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, force: false, run: f.run });
        assert.equal(f.run.mock.callCount(), 1);
        assert.equal(fs.readFileSync(f.binary, "utf8"), "new runtime");
        assert.equal(JSON.parse(fs.readFileSync(f.manifest)).sha256, f.digest);
        assert.equal(fs.existsSync(f.packageInfo.filePath), false);
    });
}

test("SHOUTcast cleanup leaves Liquidsoap downloads, unknown files and directories untouched", async (context) => {
    const f = installationFixture(context);
    const cache = path.dirname(f.packageInfo.filePath);
    const liquidsoap = path.join(f.serverRoot, "bin", "downloads", "liquidsoap", "release.zip");
    fs.mkdirSync(path.dirname(liquidsoap), { recursive: true });
    fs.writeFileSync(liquidsoap, "other runtime package");
    fs.writeFileSync(path.join(cache, "notes.txt"), "user notes");
    const archiveDirectory = path.join(cache, "sc_serv2_linux_x64-1.2.3.tar.gz");
    fs.mkdirSync(archiveDirectory);
    fs.writeFileSync(path.join(archiveDirectory, "keep.txt"), "not a downloaded file");
    await installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, run: f.run });
    assert.equal(fs.existsSync(f.packageInfo.filePath), false);
    assert.equal(fs.readFileSync(liquidsoap, "utf8"), "other runtime package");
    assert.equal(fs.readFileSync(path.join(cache, "notes.txt"), "utf8"), "user notes");
    assert.ok(fs.existsSync(path.join(archiveDirectory, "keep.txt")));
});

test("SHOUTcast keeps its package and previous runtime after failed native validation", async (context) => {
    const f = installationFixture(context, "linux", true);
    context.mock.method(systemDependencies, "inspect", () => ({ libraries: [], missing: ["libc.so.6"] }));
    await assert.rejects(installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, force: true, run: f.run }), /OS dependencies/);
    assert.ok(fs.existsSync(f.packageInfo.filePath));
    assert.equal(fs.readFileSync(f.binary, "utf8"), "previous runtime");
});

test("a cancelled Windows installer keeps its download", async (context) => {
    const f = installationFixture(context, "windows");
    await assert.rejects(installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, run: () => ({ status: 1 }) }), /installer exited/);
    assert.ok(fs.existsSync(f.packageInfo.filePath));
    assert.equal(fs.existsSync(f.manifest), false);
});

test("download cleanup failure warns without invalidating a successful installation", async (context) => {
    const f = installationFixture(context);
    const remove = fs.rmSync;
    context.mock.method(fs, "rmSync", (file, options) => {
        if (file === f.packageInfo.filePath) {
            assert.notEqual(options.recursive, true);
            throw Object.assign(new Error("download still locked"), { code: "EBUSY" });
        }
        return remove(file, options);
    });
    assert.equal(await installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, run: f.run }), f.binary);
    assert.ok(fs.existsSync(f.packageInfo.filePath));
    assert.ok(f.warnings.mock.calls.some((call) => /cleanup warning/.test(call.arguments[0])));
    assert.equal(JSON.parse(fs.readFileSync(f.manifest)).sha256, f.digest);
});

test("SHOUTcast cleanup refuses cache directories redirected by a symlink or junction", async (context) => {
    const f = installationFixture(context, "linux", true);
    const cache = path.dirname(f.packageInfo.filePath);
    const externalCache = path.join(f.serverRoot, "separate-downloads");
    fs.mkdirSync(externalCache);
    fs.rmdirSync(cache);
    fs.symlinkSync(externalCache, cache, process.platform === "win32" ? "junction" : "dir");
    await installShoutcast({ serverRoot: f.serverRoot, acceptLicense: true, run: f.run });
    assert.ok(fs.existsSync(path.join(externalCache, f.packageInfo.fileName)));
    assert.ok(f.warnings.mock.calls.some((call) => /redirected/.test(call.arguments[0])));
});
