const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const runtime = require("./liquidsoap-runtime");
const { readRuntimeManifest } = require("./runtime-manifest");
const { cleanupRuntimeDirectory } = require("./runtime-cleanup");
const ffmpegRuntime = require("./ffmpeg-runtime");

function inspectPrerequisites(profile, { run = spawnSync, userId = process.getuid?.(), managedFfmpeg = false, environment = process.env } = {}) {
    if (!["linux", "macos", "freebsd"].includes(profile.family)) {
        return { items: [], error: `No supported source build is available for ${profile.id}. Use an official compatible Liquidsoap binary.` };
    }
    const probe = (command, args) => run(command, args, {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true, env: environment,
    });
    const succeeded = (result) => !result.error && result.status === 0;
    const items = ["opam", "pkg-config", "cc", profile.family === "freebsd" ? "gmake" : "make", "bash"].map((command) => {
        const result = probe(command, ["--version"]);
        const found = succeeded(result);
        return { id: command, label: command === "cc" ? "C compiler (cc)" : command, found,
            detail: found ? String(result.stdout || "").trim().split(/\r?\n/)[0] || "available on PATH" : "not found or could not run" };
    });
    // BSD utilities do not all support --version. Ask the POSIX shell to locate them.
    for (const command of ["patch", "unzip", "tar", "diff", "m4", ...(profile.family === "linux" ? ["bwrap"] : [])]) {
        const result = probe("sh", ["-c", 'command -v "$1"', "radioserver-prerequisite", command]);
        const found = succeeded(result);
        items.push({ id: command, label: command === "bwrap" ? "bubblewrap (bwrap)" : command, found,
            detail: found ? "available on PATH" : "not found on PATH" });
    }
    const downloader = ["curl", "wget"].find((command) => succeeded(probe(command, ["--version"])));
    items.push({ id: "curl or wget", label: "OPAM download tool (curl or wget)", found: Boolean(downloader),
        detail: downloader ? `${downloader} available on PATH` : "neither curl nor wget could run" });
    const missingTools = items.filter((item) => !item.found).map((item) => item.id);
    const opam = items.find((item) => item.id === "opam");
    const opamVersion = opam.detail;
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(opamVersion);
    const oldOpam = opam.found && (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 1));
    if (oldOpam) {
        opam.found = false;
        opam.detail = `${opamVersion}; OPAM 2.1 or newer is required`;
    }
    const pkgConfig = items.find((item) => item.id === "pkg-config").found;
    const libraries = [...(managedFfmpeg ? [] : ["libavutil", "libavformat", "libavcodec", "libavdevice", "libavfilter", "libswresample", "libswscale"]), "libcurl", "libffi"];
    const missingLibraries = [];
    let oldFfmpeg = false;
    for (const library of libraries) {
        const found = pkgConfig && succeeded(probe("pkg-config", ["--exists", library]));
        let detail = pkgConfig ? "not found by pkg-config" : "cannot check without pkg-config";
        if (found) {
            const result = probe("pkg-config", ["--modversion", library]);
            detail = succeeded(result) ? String(result.stdout || "").trim() || "available through pkg-config" : "available through pkg-config (version unreadable)";
            if (library === "libavutil") {
                oldFfmpeg = !succeeded(probe("pkg-config", ["--atleast-version=59", library]));
                detail += oldFfmpeg ? "; FFmpeg 7 or newer is required (libavutil >= 59)" : "; FFmpeg >= 7 check passed";
            }
        } else {
            missingLibraries.push(library);
        }
        items.push({ id: library, label: `${library} (development)`, found: found && !(library === "libavutil" && oldFfmpeg), detail });
    }
    let error = "";
    if (userId === 0) {
        error = "Run the Liquidsoap source build as the service account, not root.";
    } else if (missingTools.length) {
        error = `Liquidsoap source build requires: ${missingTools.join(", ")}. Install the listed tools and build dependencies, then retry. RadioServer does not install OS packages.`;
    } else if (oldOpam) {
        error = `Liquidsoap source build requires OPAM 2.1 or newer; detected ${opamVersion}. Upgrade OPAM before retrying.`;
    } else if (missingLibraries.length) {
        error = `Liquidsoap source build requires ${managedFfmpeg ? "curl and libffi" : "FFmpeg, curl and libffi"} development libraries visible to pkg-config. Missing: ${missingLibraries.join(", ")}. ` +
            (managedFfmpeg ? "Install the listed development packages and retry; FFmpeg headers will be supplied by the local build." : "Install the development packages and retry; the FFmpeg executable alone is not sufficient.");
    } else if (oldFfmpeg) {
        error = "Liquidsoap source build requires FFmpeg 7 or newer development libraries (libavutil >= 59). The system FFmpeg libraries are too old. Provide compatible libraries through pkg-config and the runtime library search path, then retry; no system packages were changed.";
    }
    return { items, error };
}

function prerequisites(profile, options = {}) {
    const report = options.report || inspectPrerequisites(profile, options);
    if (report.error) throw new Error(report.error);
}

function cleanupLegacyRoot(serverRoot, root, run, environment) {
    try {
        const expected = path.resolve(serverRoot, "bin", "liquidsoap", "opam");
        if (path.resolve(root) !== expected || !fs.existsSync(expected)) return;
        if (fs.realpathSync(expected) !== expected) throw new Error("legacy OPAM root is redirected");
        const result = run("opam", ["switch", "list", "--short", `--root=${expected}`], {
            cwd: serverRoot, env: { ...environment, OPAMROOT: expected }, encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
        });
        if (result.error || result.status !== 0 || typeof result.stdout !== "string" || result.stdout.trim()) return;
        // Another platform's switches and unrecognized files must not be removed.
        const metadata = new Set(["config", "config.lock", "lock", "repo", "log", "download-cache", "opam-init", "plugins"]);
        if (fs.readdirSync(expected).some((name) => !metadata.has(name))) return;
        if (cleanupRuntimeDirectory(expected)) console.log(`Removed unused legacy OPAM root: ${expected}`);
    } catch (error) {
        console.warn(`Legacy OPAM cleanup warning: ${error.message}. The new runtime remains installed.`);
    }
}

function install(serverRoot, profile, version, {
    run = spawnSync,
    validate = runtime.checkRuntime,
    verify = runtime.checkVersion,
    activate,
    userId = process.getuid?.(),
    ffmpeg,
} = {}) {
    const buildEnvironment = ffmpegRuntime.environment(ffmpeg, profile);
    prerequisites(profile, { run, userId, environment: buildEnvironment });
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^(linux|macos|freebsd)-(x64|x86|arm64|arm)$/.test(profile.id)) {
        throw new Error("Invalid Liquidsoap source build target.");
    }
    const parent = path.join(serverRoot, "bin", "liquidsoap", profile.id);
    const opamRoot = path.join(parent, "opam");
    const runtimeRoot = path.join(parent, "runtime");
    const previous = readRuntimeManifest(path.join(runtime.getManagedRoot(serverRoot, profile), "runtime.json"));
    const switchName = `${profile.id}-${version}-${randomUUID()}`;
    const binary = path.join(opamRoot, switchName, "bin", "liquidsoap");
    // A private root leaves the user's OPAM switches, shell setup and system packages alone.
    const environment = Object.fromEntries(Object.entries(buildEnvironment).filter(([key]) => !key.startsWith("OPAM")));
    Object.assign(environment, { OPAMROOT: opamRoot, OPAMYES: "1", OPAMREQUIRECHECKSUMS: "1" });
    const command = (args, required = true, root = opamRoot) => {
        const result = run("opam", [...args, `--root=${root}`], {
            cwd: serverRoot, env: { ...environment, OPAMROOT: root }, stdio: "inherit", timeout: 3600000,
        });
        if (result.error || result.status !== 0) {
            const detail = result.error?.message || `exit ${result.status}`;
            if (required) throw new Error(`Liquidsoap source build failed during opam ${args[0]} (${detail}). Check the build output and required development libraries; the previous runtime was not replaced.`);
            console.warn(`Could not remove unused Liquidsoap OPAM switch ${args[2]} (${detail}).`);
        }
        return !result.error && result.status === 0;
    };
    fs.mkdirSync(parent, { recursive: true, mode: 0o750 });
    const staging = fs.mkdtempSync(path.join(parent, "runtime.tmp-"));
    let created = false;
    let activated = false;
    try {
        if (!fs.existsSync(path.join(opamRoot, "config"))) {
            command(["init", "--bare", "--no-setup", "--yes", "default", "https://opam.ocaml.org"]);
        }
        command(["update", "default", "--yes"]);
        created = true;
        command(["switch", "create", switchName, "--empty", "--no-switch", "--yes"]);
        command(["install", `--switch=${switchName}`, "--yes", "--no-depexts", "--require-checksums", "--jobs=2",
            "ocaml-base-compiler", "ffmpeg", `liquidsoap.${version}`]);
        const runBuilt = (executable, args, options) => run(executable, args, { ...options, env: environment });
        const check = validate(binary, runBuilt);
        if (!check.ok) throw new Error(`The compiled Liquidsoap runtime failed validation: ${check.detail}`);
        verify(binary, version, runBuilt);
        // Keep OPAM prefixes fixed; only the small runtime directory is replaced on activation.
        if (ffmpeg) {
            const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
            const libraryPath = profile.family === "macos" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
            const launcher = `#!/bin/sh\nexport PATH=${quote(path.join(ffmpeg.prefix, "bin"))}:"$PATH"\n` +
                `export ${libraryPath}=${quote(path.join(ffmpeg.prefix, "lib"))}\${${libraryPath}:+:\"$${libraryPath}\"}\n` +
                `exec ${quote(binary)} "$@"\n`;
            fs.writeFileSync(path.join(staging, "liquidsoap"), launcher, { mode: 0o755 });
        } else {
            fs.symlinkSync(binary, path.join(staging, "liquidsoap"));
        }
        fs.writeFileSync(path.join(staging, "runtime.json"), `${JSON.stringify({
            method: "opam", version, switch: switchName, root: opamRoot,
            repository: "https://opam.ocaml.org",
            ...(ffmpeg ? { ffmpegPrefix: ffmpeg.prefix, ffmpegVersion: ffmpeg.version } : {}),
        }, null, 2)}\n`, { mode: 0o640 });
        activate(staging, runtimeRoot);
        activated = true;
        const ownedSwitch = new RegExp(`^${profile.id}-\\d+\\.\\d+\\.\\d+-[a-f0-9-]{36}$`);
        const legacyRoot = path.join(serverRoot, "bin", "liquidsoap", "opam");
        if (previous.method === "opam" && [opamRoot, legacyRoot].includes(previous.root) && ownedSwitch.test(previous.switch)) {
            const removed = command(["switch", "remove", previous.switch, "--yes"], false, previous.root);
            if (removed && previous.root === legacyRoot) cleanupLegacyRoot(serverRoot, legacyRoot, run, environment);
        }
        return path.join(runtimeRoot, "liquidsoap");
    } finally {
        if (created && !activated) command(["switch", "remove", switchName, "--yes"], false);
        cleanupRuntimeDirectory(staging);
    }
}

module.exports = { inspectPrerequisites, install, prerequisites };
