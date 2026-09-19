const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const test = require("node:test");
const { prepareRuntime } = require("../app/autodj-manager");
const { resolveProfile, resolveLiquidsoapBinary } = require("../app/platform");

// These check controller integration with simulated runtime layouts, not native playback.
const profiles = ["linux", "win32", "darwin", "freebsd"].flatMap((platform) =>
    ["x64", "ia32", "arm64", "arm"].map((architecture) => resolveProfile("auto", { platform, architecture })));

for (const profile of profiles) {
    test(`${profile.id}: scheduled script preparation with a mocked native runtime`, (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-schedule-platform-"));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const runtimeRoot = path.join(root, "bin", "liquidsoap", profile.id);
        const external = ["macos", "freebsd"].includes(profile.family);
        const binary = external
            ? path.join(root, "external runtime Ș", "liquidsoap")
            : profile.family === "linux"
                ? path.join(runtimeRoot, "usr", "bin", "liquidsoap")
                : path.join(runtimeRoot, "liquidsoap.exe");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "Mocked runtime: never executed", { mode: 0o755 });
        let stdlib;
        if (profile.family === "linux") {
            stdlib = path.join(runtimeRoot, "usr", "share", "liquidsoap", "libs", "stdlib.liq");
            fs.mkdirSync(path.dirname(stdlib), { recursive: true });
            fs.writeFileSync(stdlib, "# Mock standard library\n");
            fs.writeFileSync(path.join(runtimeRoot, "runtime.json"), "{}\n");
        }
        const resolved = resolveLiquidsoapBinary(root, profile, {
            PATH: "", ...(external ? { LIQUIDSOAP_BIN: binary } : {}),
        });
        assert.equal(resolved.path, binary);
        assert.equal(resolved.found, true);
        assert.equal(resolved.source, external ? "LIQUIDSOAP_BIN" : "platform");
        const config = {
            serverRoot: root, autodjRoot: root, runtimeProfile: profile, binaryPath: resolved.path,
            configPath: path.join(root, "autodj.config.json"),
            runDirectory: path.join(root, ".run"), logDirectory: path.join(root, "logs"),
            scriptPath: path.join(root, ".run", "autodj.liq"), logPath: path.join(root, "logs", "autodj.log"),
        };
        fs.writeFileSync(config.configPath, JSON.stringify({ server: { password: "test-only-password" } }));
        fs.mkdirSync(path.join(root, "audio Ș"));
        fs.writeFileSync(path.join(root, "audio Ș", "Track name.mp3"), "mock audio");
        const playlists = [
            { id: "regular", schedule: [] },
            { id: "full_days", schedule: [{ days: ["saturday", "sunday"] }] },
            { id: "lunch", schedule: [{ days: ["friday"], start: "12:00", end: "13:00" }] },
            { id: "afternoon", schedule: [{ days: ["friday"], start: "13:00", end: "24:00" }] },
            { id: "overnight", schedule: [{ days: ["sunday"], start: "22:00", end: "02:00" }] },
        ].map((entry) => ({ ...entry, directory: "audio Ș", outputFile: `playlists/${entry.id}.lst` }));
        const configPath = path.join(root, "playlist.config.json");
        fs.writeFileSync(configPath, JSON.stringify({ playlists }));
        let version = "2.2.5";
        const scripts = [];
        const invocations = [];
        context.mock.method(childProcess, "spawnSync", (command, args, options) => {
            assert.equal(command, binary);
            assert.equal(options.shell, undefined);
            assert.equal(options.windowsHide, true);
            if (args.includes("--version")) return { status: 0, stdout: `Liquidsoap ${version}` };
            assert.ok(args.includes("--check"));
            if (stdlib) {
                assert.deepEqual(args.slice(0, 2), ["--no-stdlib", stdlib]);
                assert.ok(args.some((arg) => arg.startsWith("settings.charset.path := ")));
            } else assert.deepEqual(args.slice(0, -1), ["--check"]);
            invocations.push(args);
            scripts.push(fs.readFileSync(args.at(-1), "utf8"));
            return { status: 0, stdout: "" };
        });
        for (version of ["2.2.5", "2.4.4"]) {
            assert.throws(() => prepareRuntime(config, { validationOnly: true }), /schedules require Liquidsoap 2\.4\.5/);
            assert.equal(fs.existsSync(config.scriptPath), false);
            assert.equal(fs.existsSync(path.join(root, "playlists", "regular.lst")), false);
        }
        assert.equal(scripts.length, 0);
        version = "2.4.5";
        prepareRuntime(config, { validationOnly: true });
        assert.equal(fs.existsSync(config.scriptPath), false);
        const result = prepareRuntime(config);
        assert.equal(result.binary, binary);
        assert.deepEqual(result.runtimeConfig.playlistSources[1].schedule, [{ days: ["saturday", "sunday"], start: "00:00", end: "24:00" }]);
        const finalScript = fs.readFileSync(config.scriptPath, "utf8");
        for (const script of [...scripts, finalScript]) {
            assert.match(script, /schedules=\[\[\], \[\{start=7200, stop=10080\}\], \[\{start=6480, stop=6540\}\], \[\{start=6540, stop=7200\}\], \[\{start=0, stop=120\}, \{start=9960, stop=10080\}\]\]/);
            const uris = [...script.matchAll(/\{uri="([^"]+)"/g)].map((match) => match[1]);
            assert.equal(uris.length, playlists.length);
            assert.ok(uris.every((uri) => !uri.includes("\\")), "Liquidsoap paths use forward slashes on every platform");
        }
        assert.equal(invocations.length, 2);
        assert.ok(invocations.every((args) => !fs.existsSync(args.at(-1))), "Preflight scripts are removed after validation");
        assert.ok(finalScript.includes(path.join(root, "playlists", "regular.lst").replaceAll("\\", "/")));
        // Old runtimes remain supported when no output uses a schedule.
        fs.writeFileSync(configPath, JSON.stringify({ playlists: [playlists[0]] }));
        version = "2.2.5";
        prepareRuntime(config, { validationOnly: true });
        assert.doesNotMatch(scripts.at(-1), /  schedules=/);
    });
}
