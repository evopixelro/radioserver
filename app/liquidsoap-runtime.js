const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readRuntimeManifest } = require("./runtime-manifest");
const ffmpegRuntime = require("./ffmpeg-runtime");

function getManagedRoot(serverRoot, profile) {
    const id = profile.family === "windows" && profile.architecture === "x86" && process.arch === "x64" ? "windows-x64" : profile.id;
    const root = path.join(serverRoot, "bin", "liquidsoap", id);
    const sourceRuntime = path.join(root, "runtime");
    return fs.existsSync(path.join(sourceRuntime, "liquidsoap")) ? sourceRuntime : root;
}

function getNativeRuntime(binary, profile) {
    if (!profile.id || !path.isAbsolute(binary)) return { binary, environment: process.env };
    const root = path.dirname(binary);
    const platformRoot = path.basename(root) === "runtime" ? path.dirname(root) : root;
    const serverRoot = path.resolve(platformRoot, "..", "..", "..");
    const manifest = readRuntimeManifest(path.join(root, "runtime.json"));
    const roots = [path.join(platformRoot, "opam"), path.join(serverRoot, "bin", "liquidsoap", "opam")];
    const builds = path.join(serverRoot, "bin", "ffmpeg", profile.id, "builds");
    if (platformRoot !== path.join(serverRoot, "bin", "liquidsoap", profile.id) ||
            manifest.method !== "opam" || !roots.includes(manifest.root) || typeof manifest.ffmpegPrefix !== "string" ||
            path.dirname(manifest.ffmpegPrefix) !== builds ||
            !new RegExp(`^${profile.id}-\\d+\\.\\d+\\.\\d+-[a-f0-9-]{36}$`).test(manifest.switch || "")) {
        return { binary, environment: process.env };
    }
    return { binary: path.join(manifest.root, manifest.switch, "bin", "liquidsoap"),
        environment: ffmpegRuntime.environment({ prefix: manifest.ffmpegPrefix }, profile) };
}

function getResources(binary) {
    if (!path.isAbsolute(binary)) return null;
    const executableDirectory = path.dirname(binary);
    if (path.basename(executableDirectory) !== "bin" ||
            path.basename(path.dirname(executableDirectory)) !== "usr") return null;
    const root = path.resolve(executableDirectory, "..", "..");
    if (!fs.existsSync(path.join(root, "runtime.json"))) return null;
    return path.join(root, "usr", "share", "liquidsoap");
}

function getArguments(binary, args = []) {
    const resources = getResources(binary);
    if (!resources) return args;
    const stdlib = path.join(resources, "libs", "stdlib.liq");
    if (!fs.existsSync(stdlib)) {
        throw new Error("Local Liquidsoap standard library is missing. Run npm run install to repair bin/liquidsoap.");
    }
    const bootstrap = ["--no-stdlib", stdlib];
    const deprecated = path.join(resources, "libs", "extra", "deprecations.liq");
    if (fs.existsSync(deprecated)) bootstrap.push(deprecated);
    // Load the matching library explicitly because Linux packages use absolute system paths
    bootstrap.push(`settings.charset.path := ${JSON.stringify(path.join(resources, "camomile").replaceAll("\\", "/"))}`);
    return [...bootstrap, ...args];
}

function checkRuntime(binary, run = spawnSync) {
    try {
        const result = run(binary, getArguments(binary, ["--no-cache", "--check", "()"]), {
            encoding: "utf8", timeout: 45000, windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return {
            ok: !result.error && result.status === 0,
            detail: result.error?.message || `${result.stderr || ""}\n${result.stdout || ""}`.trim() ||
                (result.status === 0 ? "" : `Process exited with status ${result.status}${result.signal ? ` (${result.signal})` : ""}`),
        };
    } catch (error) {
        return { ok: false, detail: error.message };
    }
}

function checkVersion(binary, expected, run = spawnSync) {
    const result = run(binary, ["--version"], {
        encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const reported = `${result.stdout || ""}\n${result.stderr || ""}`;
    const version = /\bLiquidsoap\s+(\d+\.\d+\.\d+)(?:\+[^\s]+)?(?=\s|$)/i.exec(reported)?.[1];
    if (result.error || result.status !== 0 || version !== expected) {
        throw new Error(`Liquidsoap ${expected} is required by the latest official release, but ${binary} reports ${version || "an unreadable version"}. Explicit LIQUIDSOAP_BIN overrides must be updated through their original installation method, or unset to use the managed runtime.`);
    }
    return version;
}

module.exports = { checkRuntime, checkVersion, getArguments, getManagedRoot, getNativeRuntime, getResources };
