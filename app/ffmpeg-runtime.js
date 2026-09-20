const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const download = require("./download");
const { readRuntimeManifest } = require("./runtime-manifest");
const { cleanupRuntimeDirectory, managedDirectory, readCleanupManifest } = require("./runtime-cleanup");

const RELEASE_KEY = "FCF986EA15E6E293A5644F10B4322F04D67658D8";
const POSIX_FAMILIES = ["linux", "macos", "freebsd"];

function stableVersion(value) {
    return /^[78]\.\d+(?:\.\d+)?$/.test(value || "");
}

function compareVersions(left, right) {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] || 0) - (b[index] || 0);
        if (difference) return difference;
    }
    return 0;
}

async function latestVersion(fetchImplementation = globalThis.fetch) {
    const response = await fetchImplementation("https://ffmpeg.org/releases/", {
        signal: AbortSignal.timeout(30000), redirect: "error",
        headers: { "User-Agent": "RadioServer runtime installer" },
    });
    if (!response.ok) throw new Error(`Could not check official FFmpeg releases: HTTP ${response.status}.`);
    const html = await response.text();
    if (html.length > 4 * 1024 * 1024) throw new Error("The FFmpeg release catalogue exceeds the size limit.");
    // Liquidsoap 2.4 supports FFmpeg 7 and 8, not arbitrary future major versions.
    const versions = [...html.matchAll(/href=["']ffmpeg-([78]\.\d+(?:\.\d+)?)\.tar\.xz["']/g)].map((match) => match[1]);
    versions.sort((left, right) => compareVersions(right, left));
    if (!versions.length) throw new Error("No supported stable FFmpeg release was found on ffmpeg.org.");
    return versions[0];
}

function runtimeRoot(serverRoot, profile) {
    if (!POSIX_FAMILIES.includes(profile.family) || !/^(linux|macos|freebsd)-(x64|x86|arm64|arm)$/.test(profile.id)) {
        throw new Error(`No managed FFmpeg source build is available for ${profile.id}. Windows uses the official Liquidsoap bundle.`);
    }
    return path.join(serverRoot, "bin", "ffmpeg", profile.id);
}

function resolve(serverRoot, profile) {
    if (!POSIX_FAMILIES.includes(profile.family)) return null;
    const root = runtimeRoot(serverRoot, profile);
    const manifest = readRuntimeManifest(path.join(root, "runtime.json"));
    if (!stableVersion(manifest.version) || typeof manifest.prefix !== "string") return null;
    const builds = path.resolve(root, "builds");
    const prefix = path.resolve(manifest.prefix);
    if (path.dirname(prefix) !== builds || !path.basename(prefix).startsWith(`${manifest.version}-`)) return null;
    const binary = path.join(prefix, "bin", "ffmpeg");
    if (!fs.existsSync(binary)) return null;
    return { version: manifest.version, prefix, binary, sha256: manifest.sha256 };
}

function environment(runtime, profile, base = process.env) {
    if (!runtime) return { ...base };
    const env = { ...base };
    const prepend = (key, value) => { env[key] = [value, env[key]].filter(Boolean).join(path.delimiter); };
    prepend("PATH", path.join(runtime.prefix, "bin"));
    prepend("PKG_CONFIG_PATH", path.join(runtime.prefix, "lib", "pkgconfig"));
    prepend(profile.family === "macos" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH", path.join(runtime.prefix, "lib"));
    return env;
}

function validate(runtime, profile, run = spawnSync) {
    const options = { env: environment(runtime, profile), encoding: "utf8", timeout: 30000, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"] };
    const version = run(runtime.binary, ["-version"], options);
    const reported = /^ffmpeg version (\d+\.\d+(?:\.\d+)?)(?=\s)/m.exec(version.stdout || "")?.[1];
    if (version.error || version.status !== 0 || reported !== runtime.version) return false;
    const encoding = run(runtime.binary, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-t", "0.05", "-c:a", "libmp3lame", "-f", "mp3", "-"], { ...options, stdio: ["ignore", "ignore", "pipe"] });
    return !encoding.error && encoding.status === 0;
}

async function prepare(serverRoot, profile, { fetchImplementation, check = validate, force = false } = {}) {
    if (profile.family === "windows") return { strategy: "bundled" };
    runtimeRoot(serverRoot, profile);
    const version = await latestVersion(fetchImplementation);
    const current = resolve(serverRoot, profile);
    if (!force && current && compareVersions(current.version, version) > 0) {
        throw new Error(`Installed FFmpeg ${current.version} is newer than the official catalogue (${version}); refusing an automatic downgrade.`);
    }
    return { strategy: !force && current?.version === version && check(current, profile) ? "existing" : "source", version, current };
}

function inspectPrerequisites(profile, { run = spawnSync, userId = process.getuid?.() } = {}) {
    if (!POSIX_FAMILIES.includes(profile.family)) return { items: [], error: "" };
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true };
    const commands = ["cc", profile.family === "freebsd" ? "gmake" : "make", "pkg-config", "tar", "xz", "gpg",
        ...(["x64", "x86"].includes(profile.architecture) ? ["nasm"] : [])];
    const items = commands.map((command) => {
        const result = run(command, ["--version"], options);
        const found = !result.error && result.status === 0;
        return { id: command, label: command, found,
            detail: found ? String(result.stdout || "").trim().split(/\r?\n/)[0] || "available on PATH" : "not found or could not run" };
    });
    const pkgConfig = items.find((item) => item.id === "pkg-config").found;
    for (const library of ["lame", "openssl", "zlib"]) {
        const result = pkgConfig && run("pkg-config", ["--modversion", library], options);
        let found = Boolean(result && !result.error && result.status === 0);
        let detail = found ? String(result.stdout || "").trim() || "available through pkg-config" : "not found by pkg-config";
        // Older LAME development packages do not provide lame.pc.
        if (!found && library === "lame" && items.find((item) => item.id === "cc").found) {
            const linked = run("cc", ["-x", "c", "-", "-lmp3lame", "-o", "/dev/null"], {
                ...options, stdio: ["pipe", "pipe", "ignore"],
                input: "#include <lame/lame.h>\nint main(void) { lame_t encoder = lame_init(); return lame_close(encoder); }\n",
            });
            found = !linked.error && linked.status === 0;
            if (found) detail = "C headers and link library available (no pkg-config file)";
        }
        items.push({ id: library, label: `${library} (development)`, found,
            detail });
    }
    const missing = items.filter((item) => !item.found).map((item) => item.id);
    return { items, error: userId === 0 ? "Build local FFmpeg as the service account, not root." :
        missing.length ? `Local FFmpeg build requires: ${missing.join(", ")}. Install the listed OS build dependencies and retry; no system packages were changed.` : "" };
}

async function install(serverRoot, profile, plan, {
    run = spawnSync, fetchFile = download.downloadCurrent, check = validate, userId = process.getuid?.(),
} = {}) {
    if (plan.strategy === "bundled") return null;
    const root = runtimeRoot(serverRoot, profile);
    const previous = resolve(serverRoot, profile);
    if (!stableVersion(plan.version)) throw new Error("Invalid managed FFmpeg version.");
    if (plan.strategy === "existing" && plan.current && check(plan.current, profile, run)) {
        console.log(`FFmpeg is already up to date: ${plan.current.binary}`);
        return plan.current;
    }
    const report = inspectPrerequisites(profile, { run, userId });
    if (report.error) throw new Error(report.error);
    if (process.platform !== "win32" && !/^[\w./-]+$/.test(path.resolve(root))) {
        throw new Error("FFmpeg source builds require a project path without spaces or shell-special characters.");
    }
    fs.mkdirSync(path.join(root, "builds"), { recursive: true, mode: 0o750 });
    const staging = fs.mkdtempSync(path.join(root, "source.tmp-"));
    const prefix = fs.mkdtempSync(path.join(root, "builds", `${plan.version}-`));
    let activated = false;
    const command = (executable, args, options = {}) => {
        const result = run(executable, args, { cwd: staging, stdio: "inherit", timeout: 3600000, ...options });
        if (result.error || result.status !== 0) {
            let diagnostics = "";
            if (path.basename(executable) === "configure") {
                try { diagnostics = `\nFFmpeg configuration diagnostics:\n${fs.readFileSync(path.join(options.cwd, "ffbuild", "config.log"), "utf8").slice(-6000)}`; } catch {}
            }
            throw new Error(`Local FFmpeg build failed during ${path.basename(executable)}: ${result.error?.message || String(result.stderr || `exit ${result.status}`).trim().slice(-2000)}. The previous runtime was not replaced.${diagnostics}`);
        }
        return result;
    };
    try {
        console.log(`Building stable FFmpeg ${plan.version} from signed official sources in bin/ffmpeg...`);
        const archive = path.join(staging, "ffmpeg.tar.xz");
        const signature = `${archive}.asc`;
        const key = path.join(staging, "release-key.asc");
        const url = `https://ffmpeg.org/releases/ffmpeg-${plan.version}.tar.xz`;
        const sha256 = await fetchFile({ url, filePath: archive, maxBytes: 100 * 1024 * 1024 });
        await fetchFile({ url: `${url}.asc`, filePath: signature, maxBytes: 1024 * 1024 });
        await fetchFile({ url: "https://ffmpeg.org/ffmpeg-devel.asc", filePath: key, maxBytes: 1024 * 1024 });
        const keyring = path.join(staging, "gnupg");
        fs.mkdirSync(keyring, { mode: 0o700 });
        const gpg = ["--no-options", "--batch", "--no-autostart", "--no-auto-key-retrieve", "--homedir", keyring];
        const capture = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 };
        const keys = command("gpg", [...gpg, "--with-colons", "--show-keys", key], capture).stdout || "";
        if ((keys.match(/^pub:/gm) || []).length !== 1 || keys.match(/^fpr:(?:[^:]*:){8}([A-F0-9]+):/m)?.[1] !== RELEASE_KEY) {
            throw new Error("The FFmpeg signing key does not match the pinned upstream fingerprint.");
        }
        // A public-key ring is sufficient for verification; no agent or trust import is needed.
        const publicKeys = path.join(keyring, "release-key.gpg");
        command("gpg", [...gpg, "--dearmor", "--output", publicKeys, key], capture);
        const verified = command("gpg", [...gpg, "--no-default-keyring", "--keyring", publicKeys,
            "--status-fd", "1", "--verify", signature, archive], capture).stdout || "";
        if (!verified.split(/\r?\n/).some((line) => line.startsWith("[GNUPG:] VALIDSIG ") &&
                (line.split(" ")[2] === RELEASE_KEY || line.split(" ").at(-1) === RELEASE_KEY))) {
            throw new Error("The FFmpeg source signature could not be verified with the pinned upstream key.");
        }
        command("tar", ["-xf", archive, "-C", staging]);
        const source = path.join(staging, `ffmpeg-${plan.version}`);
        const env = { ...process.env };
        const flags = (kind) => {
            const result = run("pkg-config", [kind, "lame"], { ...capture, env });
            return !result.error && result.status === 0 ? String(result.stdout || "").trim() : "";
        };
        // LAME's .pc file can expose include/lame for <lame.h>, but FFmpeg uses <lame/lame.h>.
        const includeFlags = flags("--cflags-only-I").replace(/(^|\s)(-I\S+)\/lame(?=\s|$)/g, "$1$2/lame $2");
        command(path.join(source, "configure"), ["--cc=cc", `--prefix=${prefix}`, "--libdir=" + path.join(prefix, "lib"),
            "--enable-shared", "--enable-version3", "--disable-static", "--disable-doc", "--disable-debug", "--disable-ffplay",
            "--disable-autodetect", "--enable-pthreads", "--enable-openssl", "--enable-libmp3lame", "--enable-zlib",
            "--enable-rpath", `--extra-cflags=${includeFlags}`,
            `--extra-ldflags=-Wl,-rpath,${path.join(prefix, "lib")} ${flags("--libs-only-L")}`], { cwd: source, env });
        const make = profile.family === "freebsd" ? "gmake" : "make";
        command(make, ["-j2"], { cwd: source, env });
        command(make, ["install"], { cwd: source, env });
        const runtime = { version: plan.version, prefix, binary: path.join(prefix, "bin", "ffmpeg"), sha256 };
        if (!check(runtime, profile, run)) throw new Error("Local FFmpeg failed version or MP3 encoding validation; the previous runtime was not replaced.");
        for (const file of ["COPYING.LGPLv2.1", "COPYING.LGPLv3", "LICENSE.md"]) {
            if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(prefix, file));
        }
        const manifest = path.join(staging, "runtime.json");
        const record = { ...runtime, url, signingKey: RELEASE_KEY, managedBy: "radioserver" };
        fs.writeFileSync(manifest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640 });
        fs.writeFileSync(path.join(prefix, "runtime.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o640, flag: "wx" });
        if (previous && previous.prefix !== prefix) recordPreviousBuild(serverRoot, profile, previous);
        fs.renameSync(manifest, path.join(root, "runtime.json"));
        activated = true;
        console.log(`Local FFmpeg ${runtime.version} installed: ${runtime.binary}`);
        // Older prefixes may still be linked by the previous Liquidsoap build.
        return runtime;
    } finally {
        cleanupRuntimeDirectory(staging);
        if (!activated) cleanupRuntimeDirectory(prefix);
    }
}

function recordPreviousBuild(serverRoot, profile, previous) {
    try {
        if (!/^[a-f0-9]{64}$/.test(previous.sha256 || "")) return;
        const name = path.basename(previous.prefix);
        if (!/^[78]\.\d+(?:\.\d+)?-[A-Za-z0-9]{6}$/.test(name)) return;
        const directory = managedDirectory(serverRoot, "bin", "ffmpeg", profile.id, "builds", name);
        if (fs.realpathSync(previous.prefix) !== directory) return;
        fs.writeFileSync(path.join(directory, "runtime.json"), `${JSON.stringify({ ...previous, managedBy: "radioserver" }, null, 2)}\n`, { mode: 0o640, flag: "wx" });
    } catch (error) {
        if (error.code !== "EEXIST") console.warn(`FFmpeg cleanup warning: could not record the previous build (${error.message}). It will be kept.`);
    }
}

function cleanupUnused(serverRoot, profile, liquidsoapPrefix) {
    if (!POSIX_FAMILIES.includes(profile.family)) return;
    try {
        const root = managedDirectory(serverRoot, "bin", "ffmpeg", profile.id);
        const builds = managedDirectory(serverRoot, "bin", "ffmpeg", profile.id, "builds");
        const current = readCleanupManifest(root);
        const prefix = fs.realpathSync(current.prefix);
        if (path.dirname(prefix) !== builds || fs.realpathSync(liquidsoapPrefix) !== prefix) {
            throw new Error("the active FFmpeg and Liquidsoap prefixes do not match");
        }
        for (const entry of fs.readdirSync(builds, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^[78]\.\d+(?:\.\d+)?-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
            const directory = managedDirectory(serverRoot, "bin", "ffmpeg", profile.id, "builds", entry.name);
            if (directory === prefix) continue;
            let record;
            try { record = readCleanupManifest(directory); }
            catch { console.warn(`FFmpeg cleanup warning: unrecognized build was kept: ${directory}`); continue; }
            if (record.managedBy !== "radioserver" || !stableVersion(record.version) ||
                    !entry.name.startsWith(`${record.version}-`) || !/^[a-f0-9]{64}$/.test(record.sha256 || "") ||
                    typeof record.prefix !== "string" || fs.realpathSync(record.prefix) !== directory) continue;
            if (cleanupRuntimeDirectory(directory)) console.log(`Removed unused FFmpeg build: ${directory}`);
        }
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`FFmpeg cleanup warning: ${error.message}. Existing builds were kept.`);
    }
}

module.exports = { cleanupUnused, environment, inspectPrerequisites, install, latestVersion, prepare, resolve, validate };
