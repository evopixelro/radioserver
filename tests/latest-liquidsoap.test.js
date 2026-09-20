const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dependencies = require("../app/dependencies");
const releases = require("../app/liquidsoap-releases");
const runtime = require("../app/liquidsoap-runtime");
const opam = require("../app/liquidsoap-opam");

const latest = { version: "2.4.5", tag_name: "v2.4.5", assets: [] };

function fixture(context, family = "linux") {
    const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-latest-"));
    context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
    context.mock.method(releases, "latestRelease", async () => latest);
    context.mock.method(opam, "prerequisites", () => {});
    return { serverRoot, runtimeProfile: { family, architecture: "x64", id: `${family}-x64` },
        existingBinary: { found: false, source: "missing" } };
}

for (const [family, distribution, codename] of [
    ["linux", "debian", "bookworm"], ["linux", "ubuntu", "jammy"], ["linux", "fedora", ""],
    ["macos", "", ""], ["freebsd", "", ""],
]) {
    test(`${family}/${codename || distribution}: missing latest binaries use official sources`, async (context) => {
        const options = fixture(context, family);
        const plan = await dependencies.prepareInstall({ ...options, osRelease: { distribution, codename } });
        assert.equal(plan.strategy, "source");
        assert.equal(plan.version, "2.4.5");
    });
}

for (const family of ["linux", "windows", "macos", "freebsd"]) {
    for (const force of [false, true]) {
        test(`${family} ${force ? "install" : "update"} rejects an old explicit override without replacing it`, async (context) => {
            const options = fixture(context, family);
            context.mock.method(runtime, "checkVersion", () => { throw new Error("Liquidsoap 2.4.5 is required"); });
            await assert.rejects(dependencies.prepareInstall({ ...options, force,
                existingBinary: { found: true, source: "LIQUIDSOAP_BIN", path: "/user/liquidsoap" },
            }), /2\.4\.5 is required/);
            assert.deepEqual(fs.readdirSync(options.serverRoot), []);
        });
    }
}

test("a stale OPAM binary on PATH gets a private replacement, not a false success", async (context) => {
    const options = fixture(context);
    context.mock.method(runtime, "checkVersion", () => { throw new Error("old version"); });
    const plan = await dependencies.prepareInstall({ ...options, osRelease: { distribution: "debian", codename: "bookworm" },
        existingBinary: { found: true, source: "PATH", path: "/home/user/.opam/bin/liquidsoap" },
    });
    assert.equal(plan.strategy, "source");
    assert.deepEqual(fs.readdirSync(options.serverRoot), []);
});

test("unsupported source builds cannot silently keep an old Windows runtime", async (context) => {
    const options = fixture(context, "windows");
    context.mock.method(opam, "prerequisites", () => { throw new Error("No supported source build"); });
    await assert.rejects(dependencies.prepareInstall(options), /No supported source build/);
});

test("source prerequisites fail before any runtime files are created", async (context) => {
    const options = fixture(context);
    context.mock.method(opam, "prerequisites", () => { throw new Error("opam is required"); });
    await assert.rejects(dependencies.prepareInstall(options), /opam is required/);
    assert.deepEqual(fs.readdirSync(options.serverRoot), []);
});

test("install planning can defer prerequisite validation until after the complete status report", async (context) => {
    const options = fixture(context);
    context.mock.method(opam, "prerequisites", () => assert.fail("validation must be deferred"));
    const plan = await dependencies.prepareInstall({ ...options, validateSource: false });
    assert.equal(plan.strategy, "source");
    assert.deepEqual(fs.readdirSync(options.serverRoot), []);
});

test("upstream lookup errors do not fall back to the installed version", async (context) => {
    const options = fixture(context);
    context.mock.method(releases, "latestRelease", async () => { throw new Error("HTTP 503"); });
    await assert.rejects(dependencies.prepareInstall(options), /HTTP 503/);
});

for (const [family, layout] of ["linux", "macos", "freebsd"].flatMap((family) => ["legacy", "platform"].map((layout) => [family, layout]))) {
    test(`${family} ${layout} layout keeps current managed Liquidsoap on update and rebuilds it on install`, async (context) => {
        const options = fixture(context, family);
        const root = path.join(options.serverRoot, "bin", "liquidsoap", options.runtimeProfile.id, ...(layout === "platform" ? ["runtime"] : []));
        fs.mkdirSync(root, { recursive: true });
        const binary = path.join(root, "liquidsoap");
        fs.writeFileSync(binary, "current managed runtime");
        fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ method: "opam", version: "2.4.5", ffmpegPrefix: "/current" }));
        const existingBinary = { found: true, source: "platform", path: binary };
        let versionMatches = true;
        let healthy = true;
        context.mock.method(runtime, "checkVersion", () => {
            if (!versionMatches) throw new Error("old version");
            return "2.4.5";
        });
        context.mock.method(runtime, "checkRuntime", () => ({ ok: healthy }));
        const build = context.mock.method(opam, "install", () => "rebuilt");
        const settings = { ...options, existingBinary, ffmpegPlan: { strategy: "existing", current: { prefix: "/current" } } };
        const current = await dependencies.prepareInstall(settings);
        assert.equal(current.strategy, "existing");
        assert.equal(await dependencies.installDependencies({ serverRoot: options.serverRoot, plan: current, ffmpeg: { prefix: "/current" } }), binary);
        assert.equal(build.mock.callCount(), 0);
        assert.equal(opam.prerequisites.mock.callCount(), 0);
        const reinstall = await dependencies.prepareInstall({ ...settings, force: true });
        assert.equal(reinstall.strategy, "source");
        assert.equal(await dependencies.installDependencies({ serverRoot: options.serverRoot, plan: reinstall, force: true }), "rebuilt");
        assert.equal(build.mock.callCount(), 1);
        for (const ffmpegPlan of [{ strategy: "source" }, { strategy: "existing", current: { prefix: "/new" } }]) {
            const rebind = await dependencies.prepareInstall({ ...settings, ffmpegPlan });
            assert.equal(rebind.strategy, "source", "FFmpeg changes must select source prerequisites before any installations");
        }
        healthy = false;
        assert.equal((await dependencies.prepareInstall(settings)).strategy, "source", "repair damaged current runtime");
        releases.latestRelease.mock.mockImplementation(async () => ({ ...latest, version: "2.4.6", tag_name: "v2.4.6" }));
        versionMatches = false;
        const newer = await dependencies.prepareInstall(settings);
        assert.equal(newer.strategy, "source");
        assert.equal(newer.version, "2.4.6");
    });
}

for (const family of ["linux", "windows"]) {
    test(`${family} binary update skips identical packages, but installs new or missing packages and permits reinstall`, async (context) => {
        const options = fixture(context, family);
        const root = path.join(options.serverRoot, "bin", "liquidsoap", options.runtimeProfile.id);
        const binary = family === "windows" ? path.join(root, "liquidsoap.exe") : path.join(root, "usr", "bin", "liquidsoap");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "current runtime");
        fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ version: "2.4.5", sha256: "a".repeat(64) }));
        const existingBinary = { found: true, source: "platform", path: binary };
        context.mock.method(require("../app/platform"), "resolveLiquidsoapBinary", () => existingBinary);
        context.mock.method(runtime, "checkVersion", () => "2.4.5");
        context.mock.method(runtime, "checkRuntime", () => ({ ok: true }));
        const packageInfo = { version: "2.4.5", sha256: "a".repeat(64), fileName: "official-package" };
        context.mock.method(releases, "packageForRelease", () => packageInfo);
        const downloading = context.mock.method(require("../app/download"), "downloadVerified", async () => { throw new Error("DOWNLOAD_REQUIRED"); });
        const settings = { ...options, existingBinary };
        const current = await dependencies.prepareInstall(settings);
        assert.equal(current.strategy, "existing");
        assert.equal(await dependencies.installDependencies({ serverRoot: options.serverRoot, plan: current }), binary);
        assert.equal(downloading.mock.callCount(), 0);
        const reinstall = await dependencies.prepareInstall({ ...settings, force: true });
        assert.equal(reinstall.strategy, "binary");
        await assert.rejects(dependencies.installDependencies({ serverRoot: options.serverRoot, plan: reinstall, force: true }), /DOWNLOAD_REQUIRED/);
        packageInfo.sha256 = "b".repeat(64);
        const changed = await dependencies.prepareInstall(settings);
        assert.equal(changed.strategy, "binary");
        await assert.rejects(dependencies.installDependencies({ serverRoot: options.serverRoot, plan: changed }), /DOWNLOAD_REQUIRED/);
        const missing = await dependencies.prepareInstall({ ...settings, existingBinary: { found: false, source: "missing" } });
        assert.equal(missing.strategy, "binary");
        packageInfo.sha256 = "a".repeat(64);
        runtime.checkVersion.mock.mockImplementation(() => { throw new Error("binary version does not match its manifest"); });
        const damaged = await dependencies.prepareInstall(settings);
        assert.equal(damaged.strategy, "binary");
        await assert.rejects(dependencies.installDependencies({ serverRoot: options.serverRoot, plan: damaged }), /DOWNLOAD_REQUIRED/);
        fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ version: "2.5.0" }));
        await assert.rejects(dependencies.prepareInstall(settings), /refusing an automatic downgrade/);
        assert.equal(downloading.mock.callCount(), 3);
    });
}

test("updating local FFmpeg rebuilds a managed OPAM runtime but preserves explicit external binaries", async (context) => {
    const options = fixture(context);
    const root = path.join(options.serverRoot, "bin", "liquidsoap", options.runtimeProfile.id);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ method: "opam", ffmpegPrefix: "/previous" }));
    const local = { version: "8.1.2", prefix: "/new-ffmpeg" };
    const install = context.mock.method(opam, "install", (_root, _profile, _version, settings) => {
        assert.equal(settings.ffmpeg, local);
        return "rebuilt";
    });
    const plan = { runtimeProfile: options.runtimeProfile, version: "2.4.5", strategy: "external", binary: path.join(root, "liquidsoap") };
    assert.equal(await dependencies.installDependencies({ serverRoot: options.serverRoot, plan, ffmpeg: local }), "rebuilt");
    assert.equal(install.mock.callCount(), 1);
    assert.equal(await dependencies.installDependencies({ serverRoot: options.serverRoot, plan: { ...plan, binary: "/external/liquidsoap" }, ffmpeg: local }), "/external/liquidsoap");
    assert.equal(install.mock.callCount(), 1);
});

test("checks the installed executable version rather than trusting a manifest", () => {
    const run = (text) => () => ({ status: 0, stdout: text });
    for (const output of ["Liquidsoap 2.4.5", "Liquidsoap 2.4.5+dev"]) {
        assert.equal(runtime.checkVersion("liquidsoap", "2.4.5", run(output)), "2.4.5");
    }
    for (const output of ["Liquidsoap 2.4.0", "Liquidsoap 2.4.50", "Liquidsoap 2.4.5-rc1", "Liquidsoap 2.4.5.1", "OCaml 2.4.5"]) {
        assert.throws(() => runtime.checkVersion("liquidsoap", "2.4.5", run(output)), /latest official release/);
    }
});
