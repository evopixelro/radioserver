const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const download = require("./download");
const platform = require("./platform");
const systemDependencies = require("./system-dependencies");
const linuxulator = require("./linuxulator");
const { readRuntimeManifest } = require("./runtime-manifest");
const { cleanupRuntimeDirectory, renameRuntimeDirectory } = require("./runtime-cleanup");

const LICENSE_URL = "https://www.shoutcast.com/legal/agreements/dnas";
const SHOUTCAST_PACKAGES = {
    "linux-x64": {
        kind: "archive",
        fileName: "sc_serv2_linux_x64-latest.tar.gz",
        url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_linux_x64-latest.tar.gz",
    },
    "linux-x86": {
        kind: "archive",
        fileName: "sc_serv2_linux_x86-latest.tar.gz",
        url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_linux-latest.tar.gz",
    },
    "windows-x64": {
        kind: "installer",
        fileName: "sc_serv2_win64-latest.exe",
        url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_win64-latest.exe",
    },
    "windows-x86": {
        kind: "installer",
        fileName: "sc_serv2_win32-latest.exe",
        url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_win32-latest.exe",
    },
};

function getPackage(runtimeProfile, serverRoot = path.resolve(__dirname, "..")) {
    const specification = SHOUTCAST_PACKAGES[runtimeProfile.id === "freebsd-x64" ? "linux-x64" : runtimeProfile.id];
    if (!specification) return null;
    return {
        ...specification,
        filePath: path.join(
            serverRoot,
            "bin",
            "downloads",
            "shoutcast",
            specification.fileName,
        ),
    };
}

function verifyPackage(packageInfo) {
    if (!packageInfo) throw new Error("No SHOUTcast package was selected.");
    return download.verifyDownload({
        filePath: packageInfo.filePath,
        sha256: packageInfo.sha256,
        label: packageInfo.fileName,
    });
}

function getInstallRequirements(runtimeProfile, existing, { run = spawnSync } = {}) {
    const specification = getPackage(runtimeProfile);
    if (specification?.kind !== "archive" || (existing.found && (["PATH", "SC_SERV_BIN", "external"].includes(existing.source) ||
            (runtimeProfile.family === "freebsd" && !linuxulator.isLinuxBinary(existing.path))))) {
        return { items: [], missing: [] };
    }
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true };
    const tar = run("tar", ["--version"], options);
    const found = !tar.error && tar.status === 0;
    const items = [{ id: "archive:tar", label: "SHOUTcast archive extractor (tar)", found,
        detail: found ? "available on PATH" : "not found or could not run" }];
    // GNU tar delegates .tar.gz decompression to gzip; libarchive handles it itself.
    if (found && /GNU tar/.test(tar.stdout || "")) {
        const gzip = run("gzip", ["--version"], options);
        const gzipFound = !gzip.error && gzip.status === 0;
        items.push({ id: "archive:gzip", label: "SHOUTcast decompressor (gzip)", found: gzipFound,
            detail: gzipFound ? "available on PATH" : "required by GNU tar, not found or could not run" });
    }
    return { items, missing: items.filter((item) => !item.found).map((item) => item.id.slice(8)) };
}

async function downloadPackage(packageInfo) {
    packageInfo.sha256 = await download.downloadCurrent(packageInfo);
    return packageInfo.filePath;
}

function cleanupDownloads(serverRoot) {
    try {
        const root = fs.realpathSync(serverRoot);
        const downloads = path.join(root, "bin", "downloads");
        const directory = path.join(downloads, "shoutcast");
        // Never follow redirected cache directories when deleting downloaded packages.
        for (const component of [path.join(root, "bin"), downloads, directory]) {
            const stat = fs.lstatSync(component);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(`refusing to clean a redirected or non-directory cache: ${component}`);
            }
        }
        const managedPackage = /^sc_serv2_(?:linux(?:_x(?:64|86))?|win(?:32|64))[-_](?:latest|\d+(?:[._-]\d+)*)\.(?:tar\.gz|exe)(?:\.part-[a-f0-9-]{36})?$/;
        let removed = 0;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !managedPackage.test(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (path.dirname(file) !== directory) throw new Error("download cache path escaped its directory");
            try {
                // Non-recursive removal also protects a directory substituted after the listing.
                fs.rmSync(file, { force: true });
                removed += 1;
            } catch (error) {
                console.warn(`SHOUTcast download cleanup warning: could not remove ${file} (${error.code || error.message}). The installed runtime was not changed.`);
            }
        }
        for (const emptyDirectory of [directory, downloads]) {
            try { fs.rmdirSync(emptyDirectory); }
            catch (error) {
                if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
            }
        }
        if (removed) console.log(`Removed ${removed} SHOUTcast download${removed === 1 ? "" : "s"}.`);
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`SHOUTcast download cleanup warning: ${error.message}. The installed runtime was not changed.`);
    }
}

function ensureLicenseAccepted(accepted, serverRoot) {
    const licensePath = path.join(serverRoot, "bin", "shoutcast", "license.json");
    try {
        const saved = JSON.parse(fs.readFileSync(licensePath, "utf8"));
        if (saved?.accepted === true && saved.licenseUrl === LICENSE_URL) return;
    } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (!accepted) {
        throw new Error(
            "SHOUTcast license acceptance is not recorded. " +
                "Use 'npm run install' or 'npm run update', which already include --accept-license. " +
                "For a direct Node.js command, add --accept-license. " +
                `License: ${LICENSE_URL}`,
        );
    }

    fs.mkdirSync(path.dirname(licensePath), { recursive: true, mode: 0o750 });
    const temporaryPath = `${licensePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify({
            accepted: true,
            licenseUrl: LICENSE_URL,
            acceptedAt: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o640 });
        fs.renameSync(temporaryPath, licensePath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
}

function installLinuxPackage(packageInfo, serverRoot, runtimeProfile, run) {
    const installDirectory = path.join(serverRoot, "bin", "shoutcast", runtimeProfile.id);
    fs.mkdirSync(path.dirname(installDirectory), { recursive: true, mode: 0o750 });
    const staging = fs.mkdtempSync(path.join(path.dirname(installDirectory), `${runtimeProfile.id}.tmp-`));
    try {
        const result = run("tar", ["-xf", packageInfo.filePath, "-C", staging], {
            stdio: "inherit",
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error(`SHOUTcast archive extraction failed with status ${result.status}.`);
        }

        const binaryPath = path.join(staging, "sc_serv");
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`SHOUTcast archive did not contain the expected executable: ${binaryPath}`);
        }
        fs.chmodSync(binaryPath, 0o755);
        if (runtimeProfile.id === "freebsd-x64" && !linuxulator.isLinuxBinary(binaryPath)) {
            throw new Error("The SHOUTcast package is not the expected Linux x64 executable for Linuxulator.");
        }
        const libraries = systemDependencies.inspect(binaryPath, runtimeProfile);
        systemDependencies.printStatus("SHOUTcast", libraries);
        systemDependencies.assertAvailable("SHOUTcast", runtimeProfile, libraries);
        const backup = `${staging}-previous`;
        const existed = fs.existsSync(installDirectory);
        if (existed) renameRuntimeDirectory(installDirectory, backup);
        try {
            renameRuntimeDirectory(staging, installDirectory);
        } catch (error) {
            if (existed) renameRuntimeDirectory(backup, installDirectory);
            throw error;
        }
        if (existed) cleanupRuntimeDirectory(backup);
        console.log(`SHOUTcast installed for ${runtimeProfile.id}: ${path.join(installDirectory, "sc_serv")}`);
        return path.join(installDirectory, "sc_serv");
    } finally {
        cleanupRuntimeDirectory(staging);
    }
}

function installWindowsPackage(packageInfo, serverRoot, runtimeProfile, run) {
    const installDirectory = path.join(serverRoot, "bin", "shoutcast", runtimeProfile.id);
    console.log(`Opening the official SHOUTcast ${runtimeProfile.architecture} installer:`);
    console.log(packageInfo.filePath);
    console.log(`Suggested installation directory: ${installDirectory}`);
    console.log("If you choose another directory, set SC_SERV_BIN to the full executable path.");
    const result = run(packageInfo.filePath, [`/D=${installDirectory}`], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`SHOUTcast installer exited with status ${result.status}.`);
    }

    const binary = platform.resolveShoutcastBinary(serverRoot, runtimeProfile);
    if (!binary.found) {
        throw new Error("Installation completed, but sc_serv.exe was not found; set SC_SERV_BIN.");
    }
    const libraries = systemDependencies.inspect(binary.path, runtimeProfile);
    systemDependencies.printStatus("SHOUTcast", libraries);
    systemDependencies.assertAvailable("SHOUTcast", runtimeProfile, libraries);
    console.log(`SHOUTcast executable detected: ${binary.path}`);
    return binary.path;
}

async function installShoutcast({
    acceptLicense = false,
    force = false,
    serverRoot = path.resolve(__dirname, ".."),
    run = spawnSync,
} = {}) {
    const runtimeProfile = platform.resolveProfile();
    const existing = platform.resolveShoutcastBinary(serverRoot, runtimeProfile);
    const packageInfo = getPackage(runtimeProfile, serverRoot);
    const manifestPath = path.join(serverRoot, "bin", "shoutcast", runtimeProfile.id, "runtime.json");
    const installed = readRuntimeManifest(manifestPath);
    const managedLinuxulator = installed.compatibility === "linuxulator" && installed.url === packageInfo?.url && /^[a-f0-9]{64}$/.test(installed.sha256 || "");
    const suppliedFreebsd = runtimeProfile.family === "freebsd" && !managedLinuxulator;
    if (existing.found && (!packageInfo || suppliedFreebsd || ["PATH", "SC_SERV_BIN", "external"].includes(existing.source))) {
        if (force) {
            console.log(`SHOUTcast is externally managed and was not modified: ${existing.path}`);
            return existing.path;
        }
        console.log(`SHOUTcast is already available for ${runtimeProfile.id}: ${existing.path}`);
        return existing.path;
    }

    if (!packageInfo) {
        throw new Error(
            `No current official SHOUTcast package is published for ${runtimeProfile.id}. Set SC_SERV_BIN to a compatible executable.`,
        );
    }
    const compatibility = linuxulator.requirements(runtimeProfile, existing);
    if (compatibility.missing.length) throw new Error(`SHOUTcast Linux compatibility is not ready: ${compatibility.missing.join(", ")}\n${linuxulator.installationHelp()}`);
    ensureLicenseAccepted(acceptLicense, serverRoot);
    console.log(`Downloading SHOUTcast from its official distribution host for ${runtimeProfile.id}...`);
    await downloadPackage(packageInfo);
    if (existing.found && installed.sha256 === packageInfo.sha256 && !force) {
        console.log(`SHOUTcast already matches the official latest download: ${existing.path}`);
        cleanupDownloads(serverRoot);
        return existing.path;
    }
    const binary = packageInfo.kind === "archive"
        ? installLinuxPackage(packageInfo, serverRoot, runtimeProfile, run)
        : installWindowsPackage(packageInfo, serverRoot, runtimeProfile, run);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o750 });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ url: packageInfo.url, sha256: packageInfo.sha256,
        ...(runtimeProfile.id === "freebsd-x64" ? { compatibility: "linuxulator" } : {}),
    }, null, 2)}\n`, { mode: 0o640 });
    cleanupDownloads(serverRoot);
    return binary;
}

module.exports = {
    LICENSE_URL,
    SHOUTCAST_PACKAGES,
    downloadPackage,
    getPackage,
    getInstallRequirements,
    installShoutcast,
    verifyPackage,
};
