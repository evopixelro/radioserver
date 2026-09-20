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
        test(`${family} ${force ? "update" : "install"} rejects an old explicit override without replacing it`, async (context) => {
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

test("checks the installed executable version rather than trusting a manifest", () => {
    const run = (text) => () => ({ status: 0, stdout: text });
    for (const output of ["Liquidsoap 2.4.5", "Liquidsoap 2.4.5+dev"]) {
        assert.equal(runtime.checkVersion("liquidsoap", "2.4.5", run(output)), "2.4.5");
    }
    for (const output of ["Liquidsoap 2.4.0", "Liquidsoap 2.4.50", "Liquidsoap 2.4.5-rc1", "Liquidsoap 2.4.5.1", "OCaml 2.4.5"]) {
        assert.throws(() => runtime.checkVersion("liquidsoap", "2.4.5", run(output)), /latest official release/);
    }
});
