const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const runtime = require("./liquidsoap-runtime");
const { readRuntimeManifest } = require("./runtime-manifest");
const { cleanupRuntimeDirectory } = require("./runtime-cleanup");

function prerequisites(profile, { run = spawnSync, userId = process.getuid?.() } = {}) {
    if (!["linux", "macos", "freebsd"].includes(profile.family)) {
        throw new Error(`No supported source build is available for ${profile.id}. Use an official compatible Liquidsoap binary.`);
    }
    if (userId === 0) throw new Error("Run the Liquidsoap source build as the service account, not root.");
    const missing = ["opam", "pkg-config", "cc", profile.family === "freebsd" ? "gmake" : "make"].filter((command) => {
        const result = run(command, ["--version"], { stdio: "ignore", timeout: 15000, windowsHide: true });
        return result.error || result.status !== 0;
    });
    if (missing.length) {
        throw new Error(`Liquidsoap source build requires: ${missing.join(", ")}. Install these tools and FFmpeg development libraries, then retry. RadioServer does not install OS packages.`);
    }
    const libraries = ["libavutil", "libavformat", "libavcodec", "libavdevice", "libavfilter", "libswresample", "libswscale", "libcurl", "libffi"];
    const headers = run("pkg-config", ["--exists", ...libraries], { stdio: "ignore", timeout: 15000 });
    if (headers.error || headers.status !== 0) {
        throw new Error("Liquidsoap source build requires FFmpeg, curl and libffi development libraries visible to pkg-config. Install the development packages and retry; the FFmpeg executable alone is not sufficient.");
    }
}

function install(serverRoot, profile, version, {
    run = spawnSync,
    validate = runtime.checkRuntime,
    verify = runtime.checkVersion,
    activate,
    userId = process.getuid?.(),
} = {}) {
    prerequisites(profile, { run, userId });
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^(linux|macos|freebsd)-(x64|x86|arm64|arm)$/.test(profile.id)) {
        throw new Error("Invalid Liquidsoap source build target.");
    }
    const parent = path.join(serverRoot, "bin", "liquidsoap");
    const opamRoot = path.join(parent, "opam");
    const runtimeRoot = path.join(parent, profile.id);
    const previous = readRuntimeManifest(path.join(runtimeRoot, "runtime.json"));
    const switchName = `${profile.id}-${version}-${randomUUID()}`;
    const binary = path.join(opamRoot, switchName, "bin", "liquidsoap");
    // A private root leaves the user's OPAM switches, shell setup and system packages alone.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPAM")));
    Object.assign(environment, { OPAMROOT: opamRoot, OPAMYES: "1", OPAMREQUIRECHECKSUMS: "1" });
    const command = (args, required = true) => {
        const result = run("opam", [...args, `--root=${opamRoot}`], {
            cwd: serverRoot, env: environment, stdio: "inherit", timeout: 3600000,
        });
        if (result.error || result.status !== 0) {
            const detail = result.error?.message || `exit ${result.status}`;
            if (required) throw new Error(`Liquidsoap source build failed during opam ${args[0]} (${detail}). Check the build output and required development libraries; the previous runtime was not replaced.`);
            console.warn(`Could not remove unused Liquidsoap OPAM switch ${args[2]} (${detail}).`);
        }
    };
    fs.mkdirSync(parent, { recursive: true, mode: 0o750 });
    const staging = fs.mkdtempSync(path.join(parent, `${profile.id}.tmp-`));
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
        const check = validate(binary);
        if (!check.ok) throw new Error(`The compiled Liquidsoap runtime failed validation: ${check.detail}`);
        verify(binary, version);
        // OPAM embeds its prefix in compiled files. Keep the switch in place and activate a link.
        fs.symlinkSync(binary, path.join(staging, "liquidsoap"));
        fs.writeFileSync(path.join(staging, "runtime.json"), `${JSON.stringify({
            method: "opam", version, switch: switchName, root: opamRoot,
            repository: "https://opam.ocaml.org",
        }, null, 2)}\n`, { mode: 0o640 });
        activate(staging, runtimeRoot);
        activated = true;
        const ownedSwitch = new RegExp(`^${profile.id}-\\d+\\.\\d+\\.\\d+-[a-f0-9-]{36}$`);
        if (previous.method === "opam" && previous.root === opamRoot && ownedSwitch.test(previous.switch)) {
            command(["switch", "remove", previous.switch, "--yes"], false);
        }
        return path.join(runtimeRoot, "liquidsoap");
    } finally {
        if (created && !activated) command(["switch", "remove", switchName, "--yes"], false);
        cleanupRuntimeDirectory(staging);
    }
}

module.exports = { install, prerequisites };
