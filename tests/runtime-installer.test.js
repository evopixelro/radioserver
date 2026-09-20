const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dependencies = require("../app/dependencies");
const platform = require("../app/platform");
const { getInstallRequirements, installRuntime, printRuntimeStatus } = require("../app/runtime-installer");
const shoutcast = require("../app/shoutcast-package");
const ffmpeg = require("../app/ffmpeg-runtime");

test.beforeEach((context) => {
    context.mock.method(ffmpeg, "prepare", async () => ({ strategy: "bundled" }));
    context.mock.method(ffmpeg, "install", async () => null);
});

test("install refuses to replace runtimes while a managed process is running", async (context) => {
    const radio = require("../app/process-manager");
    context.mock.method(radio, "getStatus", () => ({ running: true, pid: 1234 }));
    const install = context.mock.method(shoutcast, "installShoutcast", () => assert.fail("must not download"));
    await assert.rejects(installRuntime({ acceptLicense: true }), /Stop SHOUTcast and AutoDJ/);
    assert.equal(install.mock.callCount(), 0);
});

test("runtime install forces reinstallation of SHOUTcast and Liquidsoap AutoDJ", async (context) => {
    const runtimeProfile = { family: "linux", architecture: "x64", id: "linux-x64" };
    const liquidsoap = { found: true, path: "/usr/bin/liquidsoap", source: "PATH" };
    const serverRoot = path.resolve("/srv/radioserver");

    context.mock.method(console, "log", () => {});
    context.mock.method(platform, "resolveProfile", () => runtimeProfile);
    context.mock.method(require("../app/system-dependencies"), "inspect", () => ({
        checked: true, missing: [], libraries: [], abiError: false,
    }));
    context.mock.method(platform, "resolveShoutcastBinary", () => ({
        found: true,
        path: "/srv/radioserver/bin/shoutcast/linux-x64/sc_serv",
    }));
    context.mock.method(dependencies, "getDependencyStatus", () => ({
        items: [
            { label: "Liquidsoap (AutoDJ)", found: true, detail: liquidsoap.path },
            { label: "FFmpeg", found: true, detail: "available on PATH" },
        ],
        liquidsoap,
        missing: [],
    }));
    const preflight = context.mock.method(dependencies, "preflightInstall", () => {});
    const plan = { strategy: "external", version: "2.4.5" };
    context.mock.method(dependencies, "prepareInstall", async () => plan);
    const updateShoutcast = context.mock.method(shoutcast, "installShoutcast", async () => {});
    const updateLiquidsoap = context.mock.method(dependencies, "installDependencies", async () => {});

    await installRuntime({ acceptLicense: true, force: true, serverRoot });

    assert.equal(preflight.mock.callCount(), 1);
    assert.deepEqual(updateShoutcast.mock.calls[0].arguments[0], {
        acceptLicense: true,
        force: true,
        serverRoot,
    });
    assert.deepEqual(updateLiquidsoap.mock.calls[0].arguments[0], {
        force: true,
        serverRoot,
        plan,
    });
    assert.equal(ffmpeg.prepare.mock.calls[0].arguments[2].force, true);
    assert.equal(dependencies.prepareInstall.mock.calls[0].arguments[0].force, true);
});

for (const source of ["SC_SERV_BIN", "LIQUIDSOAP_BIN"]) {
    for (const force of [false, true]) {
        test(`${force ? "install" : "update"} rejects a missing ${source} override before downloads`, async (context) => {
            context.mock.method(console, "log", () => {});
            context.mock.method(require("../app/process-manager"), "getStatus", () => ({ running: false }));
            context.mock.method(require("../app/autodj-manager"), "status", () => ({ running: false }));
            context.mock.method(platform, "resolveProfile", () => ({ family: "linux", architecture: "x64", id: "linux-x64" }));
            const shoutcastBinary = { found: false, path: "/missing/sc_serv", source: source === "SC_SERV_BIN" ? source : "platform" };
            const liquidsoap = { found: false, path: "/missing/liquidsoap", source: source === "LIQUIDSOAP_BIN" ? source : "platform" };
            context.mock.method(platform, "resolveShoutcastBinary", () => shoutcastBinary);
            context.mock.method(dependencies, "getDependencyStatus", () => ({ liquidsoap, items: [], missing: ["liquidsoap"] }));
            context.mock.method(dependencies, "preflightInstall", () => {});
            const radioInstall = context.mock.method(shoutcast, "installShoutcast", async () => {});
            const autodjInstall = context.mock.method(dependencies, "installDependencies", async () => {});
            await assert.rejects(installRuntime({ acceptLicense: true, force }), new RegExp(`${source}.*Correct.*unset`));
            assert.equal(radioInstall.mock.callCount(), 0);
            assert.equal(autodjInstall.mock.callCount(), 0);
        });
    }
}

function platformFixture(context, family, architecture, shoutcastFound) {
    const profile = { family, architecture, id: `${family}-${architecture}` };
    context.mock.method(console, "log", () => {});
    context.mock.method(require("../app/process-manager"), "getStatus", () => ({ running: false }));
    context.mock.method(require("../app/autodj-manager"), "status", () => ({ running: false }));
    context.mock.method(platform, "resolveProfile", () => profile);
    context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: shoutcastFound, path: "/provided/sc_serv", source: shoutcastFound ? "PATH" : "missing" }));
    context.mock.method(require("../app/system-dependencies"), "inspect", () => ({ checked: true, missing: [], libraries: [], abiError: false }));
    context.mock.method(dependencies, "getDependencyStatus", () => ({
        liquidsoap: { found: true, path: "/provided/liquidsoap", source: "PATH" }, items: [], missing: [],
    }));
    return {
        preflight: context.mock.method(dependencies, "preflightInstall", () => {}),
        plan: context.mock.method(dependencies, "prepareInstall", async () => ({ strategy: "external", version: "2.4.5" })),
        radio: context.mock.method(shoutcast, "installShoutcast", async () => {}),
        autodj: context.mock.method(dependencies, "installDependencies", async () => {}),
    };
}

for (const family of ["linux", "windows", "macos", "freebsd"]) {
    for (const force of [false, true]) {
        test(`${family} ${force ? "install" : "update"} applies the same reinstall policy to every component`, async (context) => {
            const fixture = platformFixture(context, family, "x64", true);
            // The public install entry point reinstalls by default; update explicitly opts out.
            await installRuntime({ acceptLicense: true, ...(force ? {} : { force: false }) });
            assert.equal(ffmpeg.prepare.mock.calls[0].arguments[2].force, force);
            assert.equal(fixture.plan.mock.calls[0].arguments[0].force, force);
            assert.equal(fixture.plan.mock.calls[0].arguments[0].ffmpegPlan.strategy, "bundled");
            assert.equal(fixture.radio.mock.calls[0].arguments[0].force, force);
            assert.equal(fixture.autodj.mock.calls[0].arguments[0].force, force);
        });
    }
}

test("latest Liquidsoap selection fails before SHOUTcast is replaced", async (context) => {
    const fixture = platformFixture(context, "linux", "x64", true);
    const lines = [];
    context.mock.method(console, "log", (line) => lines.push(line));
    context.mock.method(dependencies, "prepareInstall", async () => { throw new Error("UPSTREAM_UNAVAILABLE"); });
    await assert.rejects(installRuntime({ acceptLicense: true, force: true }), /UPSTREAM_UNAVAILABLE/);
    assert.equal(fixture.radio.mock.callCount(), 0);
    assert.equal(fixture.autodj.mock.callCount(), 0);
    assert.match(lines.join("\n"), /Linux system dependencies/);
    assert.match(lines.join("\n"), /Build requirements could not be selected/);
});

for (const family of ["linux", "windows", "macos", "freebsd"]) {
    test(`complete runtime installation accepts validated supplied binaries on ${family}`, async (context) => {
        const fixture = platformFixture(context, family, "x64", true);
        await installRuntime({ acceptLicense: true });
        assert.equal(fixture.preflight.mock.callCount(), 1);
        assert.equal(fixture.radio.mock.callCount(), 1);
        assert.equal(fixture.autodj.mock.callCount(), 1);
    });
}

for (const force of [false, true]) {
    test(`Windows ${force ? "install" : "update"} repairs a damaged managed SHOUTcast package`, async (context) => {
        const fixture = platformFixture(context, "windows", "x64", true);
        context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: true, path: "/managed/sc_serv.exe", source: "platform" }));
        context.mock.method(require("../app/system-dependencies"), "inspect", () => ({
            checked: false, libraries: [], missing: [], abiError: false, inspectionError: "Invalid PE header",
        }));
        await installRuntime({ acceptLicense: true, force });
        assert.equal(fixture.preflight.mock.callCount(), 1);
        assert.equal(fixture.radio.mock.calls[0].arguments[0].force, true);
        assert.equal(fixture.autodj.mock.callCount(), 1);
    });
}

for (const family of ["linux", "windows", "macos", "freebsd"]) {
    for (const force of [false, true]) {
        test(`${family} ${force ? "install" : "update"} stops before downloads when native inspection fails`, async (context) => {
            const fixture = platformFixture(context, family, "x64", true);
            context.mock.method(require("../app/system-dependencies"), "inspect", () => ({
                checked: false, libraries: [], missing: [], abiError: false, inspectionError: "OS inspection tool failed",
            }));
            await assert.rejects(installRuntime({ acceptLicense: true, force }), { code: "RADIO_NATIVE_INSPECTION" });
            assert.equal(fixture.preflight.mock.callCount(), 0);
            assert.equal(fixture.radio.mock.callCount(), 0);
            assert.equal(fixture.autodj.mock.callCount(), 0);
        });
    }
}

for (const [family, architecture] of [["macos", "x64"], ["macos", "arm64"], ["freebsd", "arm64"], ["linux", "arm64"], ["windows", "arm64"]]) {
    test(`${family}-${architecture} cannot install AutoDJ alone when SHOUTcast has no available binary`, async (context) => {
        const fixture = platformFixture(context, family, architecture, false);
        await assert.rejects(installRuntime({ acceptLicense: true }), /No current official SHOUTcast package.*complete radio stack/);
        assert.equal(fixture.preflight.mock.callCount(), 0);
        assert.equal(fixture.radio.mock.callCount(), 0);
        assert.equal(fixture.autodj.mock.callCount(), 0);
    });
}

for (const ready of [false, true]) {
    test(`FreeBSD Linuxulator is ${ready ? "validated before installation" : "required before any downloads or builds"}`, async (context) => {
        const fixture = platformFixture(context, "freebsd", "x64", false);
        const lines = [];
        context.mock.method(console, "log", (line) => lines.push(line));
        context.mock.method(require("../app/linuxulator"), "requirements", () => ({
            items: [{ id: "compatibility:linux64", label: "Linuxulator x64 kernel support", found: ready, detail: ready ? "enabled" : "not enabled" }],
            missing: ready ? [] : ["Linuxulator"],
        }));
        if (ready) {
            await installRuntime({ acceptLicense: true });
            assert.equal(fixture.radio.mock.callCount(), 1);
        } else {
            await assert.rejects(installRuntime({ acceptLicense: true }), /requires Linuxulator/);
            assert.equal(fixture.plan.mock.callCount(), 0);
            assert.equal(fixture.radio.mock.callCount(), 0);
            assert.equal(fixture.autodj.mock.callCount(), 0);
            assert.match(lines.join("\n"), /MISSING Linuxulator[\s\S]*pkg install linux_base-rl9[\s\S]*Runtime requirements/);
        }
    });
}

for (const force of [false, true]) {
    test(`${force ? "install" : "update"} prints every source prerequisite above runtimes before stopping`, async (context) => {
        const fixture = platformFixture(context, "linux", "x64", true);
        const lines = [];
        context.mock.method(console, "log", (line) => lines.push(line));
        context.mock.method(require("../app/system-dependencies"), "linuxDistribution", () => "debian");
        context.mock.method(dependencies, "prepareInstall", async (options) => {
            assert.equal(options.validateSource, false);
            return { strategy: "source", version: "2.4.5" };
        });
        context.mock.method(require("../app/liquidsoap-opam"), "inspectPrerequisites", () => ({
            items: [
                { label: "opam", found: true, detail: "2.1.0" },
                { label: "libavutil (development)", found: false, detail: "not found by pkg-config" },
                { label: "libffi (development)", found: false, detail: "not found by pkg-config" },
            ],
            error: "BUILD_LIBRARIES_MISSING",
        }));
        await assert.rejects(installRuntime({ acceptLicense: true, force }), /BUILD_LIBRARIES_MISSING/);
        const output = lines.join("\n");
        assert.ok(output.indexOf("Linux system dependencies") < output.indexOf("Runtime requirements"));
        assert.match(output, /Linux system dependencies \(SHOUTcast and Liquidsoap\):/);
        assert.ok(output.indexOf("SHOUTcast native libraries:") < output.indexOf("Liquidsoap source build:"));
        assert.match(output, /FOUND opam/);
        assert.match(output, /MISSING libavutil/);
        assert.match(output, /MISSING libffi/);
        assert.equal((output.match(/Runtime requirements/g) || []).length, 1);
        assert.equal(fixture.radio.mock.callCount(), 0);
        assert.equal(fixture.autodj.mock.callCount(), 0);
    });
}

test("source status uses the same plain and colored markers as the runtime list", (context) => {
    const lines = [];
    context.mock.method(console, "log", (line) => lines.push(line));
    const status = { runtimeProfile: { family: "linux", id: "linux-x64" }, items: [], systemRequirements: {
        reason: "Liquidsoap source build", sourceMissing: true,
        items: [{ label: "pkg-config", found: false, detail: "not found" }],
    } };
    printRuntimeStatus(status, { color: true });
    assert.match(lines.join("\n"), /\u001b\[31mMISSING\u001b\[0m pkg-config/);
    lines.length = 0;
    printRuntimeStatus(status, { color: false });
    assert.doesNotMatch(lines.join("\n"), /\u001b\[/);
});

test("official Linux binaries check extraction tools without probing source prerequisites", (context) => {
    context.mock.method(require("../app/liquidsoap-opam"), "inspectPrerequisites", () => assert.fail("must not probe build dependencies"));
    const status = { runtimeProfile: { family: "linux", id: "linux-x64" } };
    for (const found of [false, true]) {
        const report = getInstallRequirements(status, { strategy: "binary" }, { run: (command, args) => {
            assert.equal(command, "dpkg-deb");
            assert.deepEqual(args, ["--version"]);
            return { status: found ? 0 : 1 };
        } });
        assert.equal(report.items.length, 1);
        assert.equal(report.items[0].found, found);
        assert.equal(Boolean(report.error), !found);
        assert.match(report.note, /development libraries are not required/);
    }
    assert.equal(getInstallRequirements(status, { strategy: "external" }).items.length, 0);
    const windows = getInstallRequirements({ runtimeProfile: { family: "windows" } }, { strategy: "binary" }, {
        systemRoot: "C:\\Windows", run(command) {
            assert.equal(command, "C:\\Windows\\System32\\tar.exe");
            return { status: 0 };
        },
    });
    assert.equal(windows.items.length, 1);
    assert.equal(windows.items[0].found, true);
    assert.match(windows.note, /FFmpeg is bundled/);
});

for (const force of [false, true]) {
    test(`SHOUTcast ${force ? "install" : "update"} stops before downloads when archive tools are missing`, async (context) => {
        const fixture = platformFixture(context, "linux", "x64", true);
        const lines = [];
        context.mock.method(console, "log", (line) => lines.push(line));
        context.mock.method(shoutcast, "getInstallRequirements", () => ({
            items: [{ label: "SHOUTcast archive extractor (tar)", found: false, detail: "not found" }], missing: ["tar"],
        }));
        await assert.rejects(installRuntime({ acceptLicense: true, force }), /SHOUTcast extraction requires: tar/);
        assert.match(lines.join("\n"), /MISSING SHOUTcast archive extractor/);
        assert.match(lines.join("\n"), /SHOUTcast installation tools \(not runtime libraries\):\n    MISSING SHOUTcast archive extractor/);
        assert.equal(fixture.radio.mock.callCount(), 0);
        assert.equal(fixture.autodj.mock.callCount(), 0);
    });
}

test("Windows extraction requirements never fall back to an unrelated tar on PATH", () => {
    const report = getInstallRequirements({ runtimeProfile: { family: "windows" } }, { strategy: "binary" }, {
        systemRoot: "relative", run: () => assert.fail("must not search PATH"),
    });
    assert.equal(report.items[0].found, false);
    assert.match(report.error, /Git Bash tar is not a compatible substitute/);
});

for (const [family, missing, command] of [
    ["linux", "libtag.so.1", "sudo apt-get install libtag1v5"],
    ["windows", "vcruntime140.dll", "winget install --exact --id Microsoft.VCRedist.2015+.x64"],
    ["macos", "/opt/homebrew/lib/libtag.1.dylib", "brew install taglib"],
    ["freebsd", "libtag.so.1", "pkg install taglib"],
]) {
    test(`${family} native dependency commands appear in yellow above runtime requirements`, (context) => {
        const lines = [];
        context.mock.method(console, "log", (line) => lines.push(line));
        const native = require("../app/system-dependencies");
        const help = native.installationHelp;
        context.mock.method(native, "installationHelp", (profile, options) => help(profile, { ...options, distribution: "debian" }));
        const report = { missing: [missing], libraries: [], checked: true };
        const status = { runtimeProfile: { family, architecture: "x64" }, items: [], shoutcastLibraries: report };
        status.systemRequirements = getInstallRequirements(status, { strategy: "external" });
        printRuntimeStatus(status, { color: true });
        const output = lines.join("\n");
        assert.ok(output.includes(`\u001b[33m${command}\u001b[0m`));
        assert.ok(output.indexOf(command) < output.indexOf("Runtime requirements"));
        lines.length = 0;
        printRuntimeStatus(status, { color: false });
        assert.doesNotMatch(lines.join("\n"), /\u001b\[/);
    });
}

test("missing Linux extraction tools include a yellow command without coloring explanatory text", (context) => {
    const lines = [];
    context.mock.method(console, "log", (line) => lines.push(line));
    const status = { runtimeProfile: { family: "linux" }, items: [] };
    status.systemRequirements = getInstallRequirements(status, { strategy: "binary" }, { run: () => ({ status: 1 }) });
    printRuntimeStatus(status, { color: true });
    assert.ok(lines.includes("\u001b[33msudo apt-get install dpkg\u001b[0m"));
    assert.ok(lines.includes("Install the package extraction tool separately (Debian/Ubuntu):"));
});

for (const [family, name] of [["linux", "Linux"], ["windows", "Windows"], ["macos", "macOS"], ["freebsd", "FreeBSD"]]) {
    test(`${family} puts native libraries in the system section without duplicating them`, (context) => {
        const lines = [];
        context.mock.method(console, "log", (line) => lines.push(line));
        context.mock.method(require("../app/liquidsoap-opam"), "inspectPrerequisites", () => assert.fail("existing runtimes need no compiler"));
        const nativeLibraries = { checked: true, libraries: [{ name: "example", found: true }], missing: [] };
        const nativeItem = { id: "native:Liquidsoap", label: "Liquidsoap native libraries", found: true, detail: "1 dependency checked" };
        const status = { runtimeProfile: { family, id: `${family}-x64` }, dependencyStatus: { nativeLibraries },
            items: [nativeItem, { label: "Node.js", found: true, detail: "v24.0.0" }] };
        status.systemRequirements = getInstallRequirements(status, { strategy: "external" });
        printRuntimeStatus(status, { color: false });
        const output = lines.join("\n");
        assert.ok(output.includes(`${name} system dependencies (SHOUTcast and Liquidsoap):`));
        assert.ok(output.indexOf("Liquidsoap native libraries") < output.indexOf("Runtime requirements"));
        assert.equal((output.match(/Liquidsoap native libraries/g) || []).length, 1);
        assert.match(output, /FOUND Liquidsoap library \(example\): available to the OS loader/);
        assert.match(output, /FOUND Node\.js/);
        assert.doesNotMatch(output, /MISSING.*opam|libavutil \(development\)/);
    });
}

test("first installation distinguishes uninspected native libraries from missing executables", (context) => {
    const lines = [];
    context.mock.method(console, "log", (line) => lines.push(line));
    const status = { runtimeProfile: { family: "linux", id: "linux-x64" }, items: [
        { label: "SHOUTcast", found: false, detail: "not found" },
        { label: "Liquidsoap", found: false, detail: "not found" },
    ] };
    status.systemRequirements = getInstallRequirements(status, { strategy: "unknown" });
    printRuntimeStatus(status, { color: false });
    const output = lines.join("\n");
    for (const name of ["SHOUTcast", "Liquidsoap"]) {
        assert.ok(output.includes(`${name} native libraries:\n    NOT CHECKED: ${name} executable is not available`));
        assert.ok(output.indexOf(`${name} native libraries:`) < output.indexOf("Runtime requirements for linux-x64:"));
        assert.ok(output.includes(`MISSING ${name}: not found`));
    }
    assert.doesNotMatch(output, /FOUND|\u001b\[/);
});

test("both engines list each native library before installation tools and yellow package commands", (context) => {
    const lines = [];
    context.mock.method(console, "log", (line) => lines.push(line));
    const native = require("../app/system-dependencies");
    const help = native.installationHelp;
    context.mock.method(native, "installationHelp", (profile, options) => help(profile, { ...options, distribution: "ubuntu" }));
    const shoutcastLibraries = { checked: true, missing: ["libm.so.6"], libraries: [
        { name: "libc.so.6", found: true }, { name: "libm.so.6", found: false },
    ] };
    const nativeLibraries = { checked: true, missing: [], libraries: [{ name: "libavutil.so.59", found: true }] };
    const status = { runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" }, items: [],
        shoutcastLibraries, dependencyStatus: { nativeLibraries },
    };
    status.systemRequirements = getInstallRequirements(status, { strategy: "external" });
    status.systemRequirements.archiveItems = [{ label: "SHOUTcast archive extractor (tar)", found: true, detail: "available on PATH" }];
    printRuntimeStatus(status, { color: true });
    const output = lines.join("\n");
    assert.match(output, /\u001b\[32mFOUND\u001b\[0m SHOUTcast library \(libc\.so\.6\)/);
    assert.match(output, /\u001b\[31mMISSING\u001b\[0m SHOUTcast library \(libm\.so\.6\)/);
    assert.match(output, /\u001b\[32mFOUND\u001b\[0m Liquidsoap library \(libavutil\.so\.59\)/);
    assert.ok(output.includes("\u001b[33msudo apt-get install libc6\u001b[0m"));
    assert.ok(output.indexOf("SHOUTcast library (libm.so.6)") < output.indexOf("Liquidsoap native libraries:"));
    assert.ok(output.indexOf("Liquidsoap library (libavutil.so.59)") < output.indexOf("SHOUTcast installation tools"));
    assert.ok(output.indexOf("SHOUTcast installation tools") < output.indexOf("sudo apt-get"));
    assert.ok(output.indexOf("sudo apt-get") < output.indexOf("Runtime requirements"));
    assert.equal((output.match(/SHOUTcast library \(libc\.so\.6\)/g) || []).length, 1);
});

for (const force of [false, true]) {
    test(`${force ? "install" : "update"} builds local FFmpeg before Liquidsoap and does not require the system executable`, async (context) => {
        const fixture = platformFixture(context, "linux", "x64", true);
        const order = [];
        const local = { version: "8.1.2", prefix: "/radio/bin/ffmpeg/linux-x64/builds/8.1.2-test", binary: "/radio/local/ffmpeg" };
        context.mock.method(ffmpeg, "prepare", async () => ({ strategy: "source", version: "8.1.2" }));
        context.mock.method(ffmpeg, "inspectPrerequisites", () => ({ items: [], error: "" }));
        context.mock.method(ffmpeg, "install", async () => { order.push("ffmpeg"); return local; });
        context.mock.method(dependencies, "installDependencies", async (options) => {
            order.push("liquidsoap");
            assert.equal(options.ffmpeg, local);
        });
        await installRuntime({ force, acceptLicense: true });
        assert.deepEqual(order, ["ffmpeg", "liquidsoap"]);
        assert.equal(fixture.preflight.mock.calls[0].arguments[0].managedFfmpeg, true);
    });
}

test("missing local FFmpeg build libraries are printed before any runtimes are changed", async (context) => {
    const fixture = platformFixture(context, "linux", "x64", true);
    const lines = [];
    context.mock.method(console, "log", (line) => lines.push(line));
    context.mock.method(ffmpeg, "prepare", async () => ({ strategy: "source", version: "8.1.2" }));
    context.mock.method(ffmpeg, "inspectPrerequisites", () => ({
        items: [{ label: "lame (development)", found: false, detail: "missing" }], error: "MISSING_BUILD_LAME",
    }));
    const build = context.mock.method(ffmpeg, "install", () => assert.fail("must not build"));
    await assert.rejects(installRuntime({ acceptLicense: true }), /MISSING_BUILD_LAME/);
    const output = lines.join("\n");
    assert.ok(output.indexOf("MISSING lame") < output.indexOf("Runtime requirements"));
    assert.match(output, /Suggested FFmpeg build dependencies/);
    assert.equal(build.mock.callCount(), 0);
    assert.equal(fixture.radio.mock.callCount(), 0);
    assert.equal(fixture.autodj.mock.callCount(), 0);
});
