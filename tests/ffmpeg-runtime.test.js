const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ffmpeg = require("../app/ffmpeg-runtime");

const key = "FCF986EA15E6E293A5644F10B4322F04D67658D8";
const profile = { family: "linux", architecture: "x64", id: "linux-x64" };

test("FFmpeg selection uses official stable compatible releases, never nightly or future majors", async () => {
    const version = await ffmpeg.latestVersion(async (url, options) => {
        assert.equal(url, "https://ffmpeg.org/releases/");
        assert.equal(options.redirect, "error");
        return { ok: true, text: async () => ['8.1', '8.1.2', '7.1.5', '8.1.10-rc1', '9.0.2', 'snapshot'].map((v) => `<a href="ffmpeg-${v}.tar.xz">file</a>`).join("\n") };
    });
    assert.equal(version, "8.1.2");
    await assert.rejects(ffmpeg.latestVersion(async () => ({ ok: false, status: 503 })), /HTTP 503/);
    await assert.rejects(ffmpeg.latestVersion(async () => ({ ok: true, text: async () => '<a href="ffmpeg-snapshot.tar.xz">nightly</a>' })), /No supported stable/);
});

for (const family of ["linux", "macos", "freebsd"]) {
    test(`${family} FFmpeg prerequisites report build libraries without requesting system FFmpeg`, () => {
        const probes = [];
        const report = ffmpeg.inspectPrerequisites({ family, architecture: "x64" }, { userId: 1000, run(command, args) {
            probes.push([command, ...args]);
            return { status: command === "gpg" || args.includes("openssl") ? 1 : 0, stdout: "3.100" };
        } });
        assert.deepEqual(report.items.filter((item) => !item.found).map((item) => item.id), ["gpg", "openssl"]);
        assert.match(report.error, /gpg, openssl/);
        assert.ok(probes.some(([command]) => command === (family === "freebsd" ? "gmake" : "make")));
        assert.equal(probes.some(([command, ...args]) => command === "ffmpeg" || args.some((arg) => arg.startsWith("libav"))), false);
    });
}

test("Ubuntu LAME headers work even without a lame.pc file", () => {
    const report = ffmpeg.inspectPrerequisites(profile, { userId: 1000, run(command, args, options) {
        if (command === "pkg-config" && args.includes("lame")) return { status: 1 };
        if (command === "cc" && args.includes("-lmp3lame")) {
            assert.match(options.input, /lame_init/);
            assert.equal(args.at(-1), "/dev/null");
        }
        return { status: 0, stdout: "available" };
    } });
    assert.equal(report.error, "");
    assert.match(report.items.find((item) => item.id === "lame").detail, /no pkg-config file/);
});

test("managed FFmpeg environment preserves existing paths without changing the process environment", () => {
    const prefix = path.resolve("/private/ffmpeg");
    const original = { PATH: "/usr/bin", PKG_CONFIG_PATH: "/usr/lib/pkgconfig", LD_LIBRARY_PATH: "/custom/lib", KEEP: "value" };
    const env = ffmpeg.environment({ prefix }, profile, original);
    assert.equal(env.PATH, `${path.join(prefix, "bin")}${path.delimiter}/usr/bin`);
    assert.equal(env.LD_LIBRARY_PATH, `${path.join(prefix, "lib")}${path.delimiter}/custom/lib`);
    assert.equal(env.KEEP, "value");
    assert.equal(original.PATH, "/usr/bin");
    assert.equal(ffmpeg.environment({ prefix }, { family: "macos" }, {}).DYLD_LIBRARY_PATH, path.join(prefix, "lib"));
});

function fixture(context, failure, runtimeProfile = profile) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-ffmpeg-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    context.mock.method(console, "log", () => {});
    const commands = [];
    const manifest = path.join(root, "bin", "ffmpeg", runtimeProfile.id, "runtime.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, "previous manifest");
    const options = { userId: 1000,
        fetchFile: async ({ filePath, url }) => {
            assert.match(url, /^https:\/\/ffmpeg\.org\//);
            fs.writeFileSync(filePath, "signed test archive");
            return "a".repeat(64);
        },
        run(command, args, options) {
            commands.push({ command, args, options });
            if (args.includes("--show-keys")) return { status: 0, stdout: `pub:-:2048:1:KEY:0::::::\nfpr:::::::::${failure === "key" ? "0".repeat(40) : key}:\n` };
            if (args.includes("--verify")) return { status: failure === "signature" ? 1 : 0, stdout: `[GNUPG:] VALIDSIG ${key} 0 0\n` };
            if (args.includes("-j2") && failure === "compile") return { status: 1 };
            return { status: 0, stdout: command === "pkg-config" && /flags|libs/.test(args[0]) ? "" : "3.0.0" };
        },
        check(runtime) {
            fs.mkdirSync(path.dirname(runtime.binary), { recursive: true });
            fs.writeFileSync(runtime.binary, "compiled stable FFmpeg");
            return failure !== "validation";
        },
    };
    return { root, commands, manifest, options };
}

test("managed FFmpeg verifies signatures before extraction and activates only a validated build", async (context) => {
    const { root, commands, manifest, options } = fixture(context);
    const runtime = await ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options);
    const verified = commands.findIndex(({ args }) => args.includes("--verify"));
    assert.ok(verified < commands.findIndex(({ command, args }) => command === "tar" && args[0] === "-xf"));
    assert.equal(commands.some(({ args }) => args.includes("--import")), false);
    assert.ok(commands[verified].args.includes("--no-autostart"));
    assert.ok(commands[verified].args.includes("--no-default-keyring"));
    const configuration = commands.find(({ command }) => path.basename(command) === "configure");
    assert.ok(configuration.args.includes("--cc=cc"));
    assert.ok(configuration.args.includes("--enable-libmp3lame"));
    assert.ok(configuration.args.includes("--enable-openssl"));
    assert.ok(configuration.args.includes("--enable-shared"));
    assert.ok(configuration.args.includes(`--prefix=${runtime.prefix}`));
    assert.equal(JSON.parse(fs.readFileSync(manifest)).signingKey, key);
    assert.equal(ffmpeg.resolve(root, profile).prefix, runtime.prefix);
    assert.deepEqual(fs.readdirSync(path.dirname(manifest)).sort(), ["builds", "runtime.json"]);
    assert.equal(commands.some(({ command }) => ["sudo", "apt-get", "brew", "pkg"].includes(command)), false);
});

test("FFmpeg can include lame/lame.h when pkg-config exposes the nested LAME directory", async (context) => {
    const { root, commands, options } = fixture(context);
    const run = options.run;
    options.run = (command, args, settings) => {
        if (command === "pkg-config" && args[0] === "--cflags-only-I") {
            return { status: 0, stdout: "-I/opt/homebrew/Cellar/lame/4.0/include/lame -I/other/include" };
        }
        return run(command, args, settings);
    };
    await ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options);
    const configuration = commands.find(({ command }) => path.basename(command) === "configure");
    assert.ok(configuration.args.includes("--extra-cflags=-I/opt/homebrew/Cellar/lame/4.0/include/lame -I/opt/homebrew/Cellar/lame/4.0/include -I/other/include"));
});

for (const failure of ["key", "signature", "compile", "validation"]) {
    test(`FFmpeg ${failure} failure preserves the active manifest and removes only staging files`, async (context) => {
        const { root, manifest, options, commands } = fixture(context, failure);
        await assert.rejects(ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options));
        assert.equal(fs.readFileSync(manifest, "utf8"), "previous manifest");
        assert.deepEqual(fs.readdirSync(path.join(path.dirname(manifest), "builds")), []);
        assert.deepEqual(fs.readdirSync(path.dirname(manifest)).sort(), ["builds", "runtime.json"]);
        if (["key", "signature"].includes(failure)) assert.equal(commands.some(({ command, args }) => command === "tar" && args.includes("-xf")), false);
    });
}

test("FFmpeg update reuses the validated current prefix without build tools or downloads", async (context) => {
    const { root, options } = fixture(context);
    const runtime = await ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options);
    const plan = await ffmpeg.prepare(root, profile, { check: () => true,
        fetchImplementation: async () => ({ ok: true, text: async () => '<a href="ffmpeg-8.1.2.tar.xz">stable</a>' }),
    });
    assert.equal(plan.strategy, "existing");
    assert.equal((await ffmpeg.install(root, profile, plan, { check: () => true,
        run: () => assert.fail("must not compile"), fetchFile: () => assert.fail("must not download"),
    })).prefix, runtime.prefix);
});

for (const family of ["linux", "macos", "freebsd"]) {
    test(`${family} FFmpeg cleanup retains the active build and removes only owned unused builds`, async (context) => {
        const target = { ...profile, family, id: `${family}-x64` };
        const { root, options } = fixture(context, undefined, target);
        context.mock.method(console, "warn", () => {});
        const old = await ffmpeg.install(root, target, { strategy: "source", version: "8.1.2" }, options);
        // Older installations have only the active manifest; the next install records their ownership.
        fs.unlinkSync(path.join(old.prefix, "runtime.json"));
        const current = await ffmpeg.install(root, target, { strategy: "source", version: "8.1.2" }, options);
        const unknown = path.join(path.dirname(current.prefix), "8.1.1-ABC123");
        fs.mkdirSync(unknown);
        fs.writeFileSync(path.join(unknown, "keep.txt"), "not a registered build");
        ffmpeg.cleanupUnused(root, target, old.prefix);
        assert.ok(fs.existsSync(old.binary), "retain old libraries while Liquidsoap still references them");
        ffmpeg.cleanupUnused(root, target, current.prefix);
        assert.equal(fs.existsSync(old.prefix), false);
        assert.ok(fs.existsSync(current.binary));
        assert.equal(fs.readFileSync(path.join(unknown, "keep.txt"), "utf8"), "not a registered build");
        ffmpeg.cleanupUnused(root, target, current.prefix);
        assert.ok(fs.existsSync(current.binary));
    });
}

test("FFmpeg cleanup preserves redirected builds", async (context) => {
    const { root, options } = fixture(context);
    const old = await ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options);
    const current = await ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options);
    const outside = path.join(root, "outside");
    fs.renameSync(old.prefix, outside);
    fs.symlinkSync(outside, old.prefix, process.platform === "win32" ? "junction" : "dir");
    ffmpeg.cleanupUnused(root, profile, current.prefix);
    assert.ok(fs.existsSync(path.join(outside, "bin", "ffmpeg")));
    assert.ok(fs.existsSync(current.binary));
});

for (const family of ["linux", "macos", "freebsd"]) {
    test(`${family} reinstalls FFmpeg at the same version only when forced by install`, async (context) => {
        const target = { ...profile, family, id: `${family}-x64` };
        const { root, options } = fixture(context, undefined, target);
        const original = await ffmpeg.install(root, target, { strategy: "source", version: "8.1.2" }, options);
        const lookup = { check: () => true,
            fetchImplementation: async () => ({ ok: true, text: async () => '<a href="ffmpeg-8.1.2.tar.xz">stable</a>' }) };
        assert.equal((await ffmpeg.prepare(root, target, lookup)).strategy, "existing");
        const reinstall = await ffmpeg.prepare(root, target, { ...lookup, force: true });
        assert.equal(reinstall.strategy, "source");
        const replacement = await ffmpeg.install(root, target, reinstall, options);
        assert.notEqual(replacement.prefix, original.prefix);
        assert.equal(replacement.version, original.version);
        assert.equal(ffmpeg.resolve(root, target).prefix, replacement.prefix);
        assert.ok(fs.existsSync(original.binary), "preserve libraries still used by the previous Liquidsoap");
    });
}

test("FFmpeg update builds only a new, missing or damaged runtime and refuses downgrades", async (context) => {
    const { root, options } = fixture(context);
    const lookup = (version, check = () => true) => ({ check,
        fetchImplementation: async () => ({ ok: true, text: async () => `<a href="ffmpeg-${version}.tar.xz">stable</a>` }) });
    assert.equal((await ffmpeg.prepare(root, profile, lookup("8.1.2"))).strategy, "source");
    await ffmpeg.install(root, profile, { strategy: "source", version: "8.1.2" }, options);
    assert.equal((await ffmpeg.prepare(root, profile, lookup("8.1.2"))).strategy, "existing");
    assert.equal((await ffmpeg.prepare(root, profile, lookup("8.1.2", () => false))).strategy, "source");
    const update = await ffmpeg.prepare(root, profile, lookup("8.1.3"));
    assert.equal(update.strategy, "source");
    assert.equal(update.version, "8.1.3");
    for (const version of ["7.10.20", "8.0.20", "8.1", "8.1.1"]) {
        await assert.rejects(ffmpeg.prepare(root, profile, lookup(version)), /refusing an automatic downgrade/);
    }
});

test("FFmpeg validation checks exact stable version and MP3 encoding", () => {
    const runtime = { version: "8.1.2", prefix: "/private", binary: "/private/bin/ffmpeg" };
    for (const version of ["8.1.2", "8.1.2-dev", "4.4.2"]) {
        const valid = ffmpeg.validate(runtime, profile, (_command, args) => ({ status: 0, stdout: args[0] === "-version" ? `ffmpeg version ${version} Copyright` : "" }));
        assert.equal(valid, version === "8.1.2");
    }
    assert.equal(ffmpeg.validate(runtime, profile, (_command, args) => ({ status: args[0] === "-version" ? 0 : 1, stdout: "ffmpeg version 8.1.2 Copyright" })), false);
});

test("Windows uses the local Liquidsoap FFmpeg bundle without Unix builds or downloads", async () => {
    const windows = { family: "windows", id: "windows-x64", architecture: "x64" };
    const plan = await ffmpeg.prepare("/project", windows, { fetchImplementation: () => assert.fail("no Unix source lookup") });
    assert.deepEqual(plan, { strategy: "bundled" });
    assert.equal(await ffmpeg.install("/project", windows, plan), null);
});
