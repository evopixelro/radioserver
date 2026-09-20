const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const opam = require("../app/liquidsoap-opam");
const { activateRuntime } = require("../app/dependencies");

for (const family of ["linux", "macos", "freebsd"]) {
    test(`${family} source build uses a private switch and the exact official version`, (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-opam-"));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        // Simulated Unix builds also run on Windows hosts without symlink privileges.
        const links = context.mock.method(fs, "symlinkSync", (source, destination) => fs.copyFileSync(source, destination));
        const commands = [];
        const profile = { family, id: `${family}-x64` };
        const parent = path.join(root, "bin", "liquidsoap");
        const result = opam.install(root, profile, "2.4.5", {
            userId: 1000,
            run(command, args, options) {
                commands.push({ command, args, options });
                if (command === "opam" && args[0] === "install") {
                    const switchName = args.find((value) => value.startsWith("--switch=")).slice(9);
                    const binary = path.join(parent, "opam", switchName, "bin", "liquidsoap");
                    fs.mkdirSync(path.dirname(binary), { recursive: true });
                    fs.writeFileSync(binary, "compiled latest runtime");
                    assert.equal(options.env.OPAMROOT, path.join(parent, "opam"));
                    assert.equal(options.env.OPAMREQUIRECHECKSUMS, "1");
                }
                return { status: 0, stdout: "2.1.0" };
            },
            validate: (binary) => ({ ok: fs.readFileSync(binary, "utf8") === "compiled latest runtime" }),
            verify: (_binary, version) => assert.equal(version, "2.4.5"),
            activate: activateRuntime,
        });
        assert.equal(result, path.join(parent, profile.id, "liquidsoap"));
        assert.equal(links.mock.callCount(), 1);
        const install = commands.find(({ args }) => args[0] === "install");
        assert.ok(install.args.includes("liquidsoap.2.4.5"));
        assert.ok(install.args.includes("ffmpeg"));
        assert.ok(install.args.includes("--no-depexts"));
        assert.ok(install.args.includes("--require-checksums"));
        assert.ok(commands.find(({ args }) => args[0] === "init").args.includes("https://opam.ocaml.org"));
        assert.equal(commands.some(({ args }) => args.includes("--disable-sandboxing")), false);
        const manifest = JSON.parse(fs.readFileSync(path.join(parent, profile.id, "runtime.json"), "utf8"));
        assert.equal(manifest.version, "2.4.5");
        assert.equal(manifest.method, "opam");
    });
}

for (const failure of ["compile", "validation", "version", "activation"]) {
    test(`source ${failure} failure preserves the previous runtime and removes only the new switch`, (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-opam-failure-"));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        context.mock.method(fs, "symlinkSync", (_source, destination) => fs.writeFileSync(destination, "new runtime"));
        const runtime = path.join(root, "bin", "liquidsoap", "linux-x64");
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(path.join(runtime, "liquidsoap"), "old runtime");
        const commands = [];
        assert.throws(() => opam.install(root, { family: "linux", id: "linux-x64" }, "2.4.5", {
            userId: 1000,
            run(_command, args) {
                commands.push(args);
                return { status: failure === "compile" && args[0] === "install" ? 1 : 0, stdout: "2.1.0" };
            },
            validate: () => ({ ok: failure !== "validation", detail: "TEST_VALIDATION" }),
            verify: () => { if (failure === "version") throw new Error("TEST_VERSION"); },
            activate: () => { throw new Error("TEST_ACTIVATION"); },
        }), /source build failed|TEST_/);
        assert.equal(fs.readFileSync(path.join(runtime, "liquidsoap"), "utf8"), "old runtime");
        const created = commands.find((args) => args[0] === "switch" && args[1] === "create")[2];
        const removed = commands.filter((args) => args[0] === "switch" && args[1] === "remove");
        assert.deepEqual(removed.map((args) => args[2]), [created]);
    });
}

test("source builds refuse root and unsupported Windows targets", () => {
    assert.throws(() => opam.prerequisites({ family: "linux", id: "linux-x64" }, { userId: 0 }), /not root/);
    assert.throws(() => opam.prerequisites({ family: "windows", id: "windows-arm64" }), /No supported source build/);
});

test("missing build tools are reported without installing OS packages", () => {
    assert.throws(() => opam.prerequisites({ family: "freebsd" }, { userId: 1000,
        run: (command) => ({ status: command === "gmake" ? 1 : 0 }),
    }), /gmake.*does not install OS packages/);
});

test("managed FFmpeg planning does not require Ubuntu's libav development packages", () => {
    const report = opam.inspectPrerequisites({ family: "linux" }, { userId: 1000, managedFfmpeg: true,
        run: (_command, args) => {
            assert.equal(args.some((arg) => /^lib(?:av|sw)/.test(arg)), false);
            return { status: 0, stdout: "2.1.0" };
        },
    });
    assert.equal(report.error, "");
    assert.deepEqual(report.items.filter((item) => item.label.endsWith("(development)")).map((item) => item.id), ["libcurl", "libffi"]);
});

test("managed FFmpeg prerequisite errors do not request system FFmpeg headers", () => {
    const report = opam.inspectPrerequisites({ family: "linux" }, { userId: 1000, managedFfmpeg: true,
        run: (_command, args) => ({ status: args.includes("libffi") ? 1 : 0, stdout: "2.1.0" }),
    });
    assert.match(report.error, /Missing: libffi/);
    assert.match(report.error, /FFmpeg headers will be supplied by the local build/);
    assert.doesNotMatch(report.error, /requires FFmpeg,|FFmpeg executable alone/);
});

for (const family of ["linux", "macos", "freebsd"]) {
    test(`${family} local FFmpeg build creates a persistent launcher with private library paths`, (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-opam-local-"));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const profile = { family, id: `${family}-x64`, architecture: "x64" };
        const ffmpeg = { version: "8.1.2", prefix: path.join(root, "bin", "ffmpeg", profile.id, "builds", "8.1.2-example") };
        const libraryPath = family === "macos" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
        const binary = opam.install(root, profile, "2.4.5", { ffmpeg, userId: 1000,
            run(_command, _args, options) {
                assert.ok(options.env.PKG_CONFIG_PATH.startsWith(path.join(ffmpeg.prefix, "lib", "pkgconfig")));
                return { status: 0, stdout: "2.1.0" };
            },
            validate: () => ({ ok: true }), verify: () => "2.4.5", activate: activateRuntime,
        });
        const launcher = fs.readFileSync(binary, "utf8");
        assert.match(launcher, /^#!\/bin\/sh\nexport PATH=/);
        assert.ok(launcher.includes(`export ${libraryPath}=`));
        assert.ok(launcher.includes(`\${${libraryPath}:+:\"$${libraryPath}\"}`));
        assert.match(launcher, /exec '[^\n]+' "\$@"\n$/);
        const native = require("../app/liquidsoap-runtime").getNativeRuntime(binary, profile);
        assert.ok(native.binary.startsWith(path.join(root, "bin", "liquidsoap", "opam")));
        assert.ok(native.environment[libraryPath].startsWith(path.join(ffmpeg.prefix, "lib")));
        assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(binary), "runtime.json"))).ffmpegPrefix, ffmpeg.prefix);
    });
}

test("source prerequisites reject obsolete OPAM and missing development libraries", () => {
    const profile = { family: "linux", id: "linux-x64" };
    for (const version of ["1.2.2", "2.0.10", "unknown"]) {
        assert.throws(() => opam.prerequisites(profile, { userId: 1000,
            run: () => ({ status: 0, stdout: version }),
        }), /OPAM 2.1 or newer/);
    }
    assert.throws(() => opam.prerequisites(profile, { userId: 1000,
        run: (_command, args) => ({ status: args[0] === "--exists" ? 1 : 0, stdout: "2.1.0" }),
    }), /development libraries visible to pkg-config/);
    assert.throws(() => opam.prerequisites(profile, { userId: 1000,
        run: (_command, args) => ({ status: args[0] === "--atleast-version=59" ? 1 : 0, stdout: "2.1.0" }),
    }), /FFmpeg 7 or newer.*no system packages were changed/);
});

test("source report lists each development library and continues after missing dependencies", () => {
    const probes = [];
    const report = opam.inspectPrerequisites({ family: "linux" }, { userId: 1000, run(command, args) {
        probes.push([command, ...args]);
        if (command === "pkg-config" && args[0] === "--exists" && ["libavdevice", "libffi"].includes(args[1])) return { status: 1 };
        return { status: 0, stdout: command === "opam" ? "2.1.0" : "60.8.100" };
    } });
    assert.equal(report.items.length, 20);
    assert.deepEqual(report.items.filter((item) => !item.found).map((item) => item.id), ["libavdevice", "libffi"]);
    assert.match(report.error, /Missing: libavdevice, libffi/);
    assert.match(report.items.find((item) => item.id === "libavutil").detail, /60\.8\.100.*check passed/);
    assert.ok(probes.some((args) => args[1] === "--exists" && args[2] === "libcurl"));
    assert.throws(() => opam.prerequisites({ family: "linux" }, { report }), /Missing: libavdevice, libffi/);
});

test("missing pkg-config leaves every library visible but explicitly unchecked", () => {
    const report = opam.inspectPrerequisites({ family: "linux" }, { userId: 1000, run(command, args) {
        if (command === "pkg-config") {
            assert.deepEqual(args, ["--version"]);
            return { error: new Error("ENOENT"), status: null };
        }
        return { status: 0, stdout: "2.1.0" };
    } });
    assert.equal(report.items.filter((item) => item.label.endsWith("(development)")).length, 9);
    for (const item of report.items.filter((item) => item.label.endsWith("(development)"))) {
        assert.equal(item.found, false);
        assert.match(item.detail, /cannot check without pkg-config/);
    }
    assert.match(report.error, /requires: pkg-config/);
});

test("source report marks obsolete OPAM and FFmpeg as incompatible instead of available", () => {
    const report = opam.inspectPrerequisites({ family: "linux" }, { userId: 1000, run(command, args) {
        return { status: args[0] === "--atleast-version=59" ? 1 : 0, stdout: command === "opam" ? "2.0.10" : "57.28.100" };
    } });
    assert.deepEqual(report.items.filter((item) => !item.found).map((item) => item.id), ["opam", "libavutil"]);
    assert.match(report.items.find((item) => item.id === "libavutil").detail, /57\.28\.100.*FFmpeg 7 or newer/);
});

test("source reports command timeouts as missing without stopping the remaining probes", () => {
    const report = opam.inspectPrerequisites({ family: "freebsd" }, { userId: 1000, run(command) {
        if (command === "gmake") return { error: new Error("ETIMEDOUT"), status: null };
        return { status: 0, stdout: "2.1.0" };
    } });
    assert.equal(report.items.at(-1).id, "libffi");
    assert.equal(report.items.find((item) => item.id === "gmake").found, false);
    assert.match(report.error, /requires: gmake/);
});

test("source report checks OPAM helper tools and accepts wget without requiring curl", () => {
    const report = opam.inspectPrerequisites({ family: "linux" }, { userId: 1000, run(command, args) {
        if (command === "sh") {
            assert.deepEqual(args.slice(0, 3), ["-c", 'command -v "$1"', "radioserver-prerequisite"]);
            return { status: ["patch", "bwrap"].includes(args[3]) ? 1 : 0 };
        }
        return { status: command === "curl" ? 1 : 0, stdout: "2.1.0" };
    } });
    assert.deepEqual(report.items.filter((item) => !item.found).map((item) => item.id), ["patch", "bwrap"]);
    assert.match(report.items.find((item) => item.id === "curl or wget").detail, /wget available/);
    assert.match(report.error, /requires: patch, bwrap/);
});
