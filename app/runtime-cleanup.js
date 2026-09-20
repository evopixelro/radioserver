const fs = require("node:fs");
const path = require("node:path");
const retrySignal = new Int32Array(new SharedArrayBuffer(4));

function renameRuntimeDirectory(source, destination, {
    platform = process.platform, rename = fs.renameSync,
    pause = (milliseconds) => Atomics.wait(retrySignal, 0, 0, milliseconds),
} = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return rename(source, destination);
        } catch (error) {
            // Windows can briefly keep a validated executable or its DLLs locked after exit.
            if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 20) throw error;
            pause(250);
        }
    }
}

function cleanupRuntimeDirectory(directory) {
    try {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return true;
    } catch (error) {
        console.warn(`Runtime cleanup warning: could not fully remove ${directory} (${error.code || error.message}). Close processes using that directory before removing the remaining files.`);
        return false;
    }
}

function managedDirectory(serverRoot, ...parts) {
    let directory = fs.realpathSync(serverRoot);
    for (const part of parts) {
        if (!part || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error("Invalid managed directory component");
        directory = path.join(directory, part);
        const entry = fs.lstatSync(directory);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new Error(`refusing to clean a redirected or non-directory path: ${directory}`);
        }
    }
    return directory;
}

function cleanupDownloadCache(serverRoot, component, managedPackage, { keep = [] } = {}) {
    try {
        if (!["SHOUTcast", "Liquidsoap"].includes(component)) throw new Error("Unknown download cache");
        const directory = managedDirectory(serverRoot, "bin", "downloads", component.toLowerCase());
        let removed = 0;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || keep.includes(entry.name) || !managedPackage.test(entry.name)) continue;
            const file = path.join(directory, entry.name);
            if (path.dirname(file) !== directory) throw new Error("download cache path escaped its directory");
            try {
                fs.rmSync(file, { force: true });
                removed += 1;
            } catch (error) {
                console.warn(`${component} download cleanup warning: could not remove ${file} (${error.code || error.message}). The installed runtime was not changed.`);
            }
        }
        for (const empty of [directory, path.dirname(directory)]) {
            try { fs.rmdirSync(empty); }
            catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
        }
        if (removed) console.log(`Removed ${removed} ${component} download${removed === 1 ? "" : "s"}.`);
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`${component} download cleanup warning: ${error.message}. The installed runtime was not changed.`);
    }
}

function readCleanupManifest(directory) {
    const file = path.join(directory, "runtime.json");
    const entry = fs.lstatSync(file);
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > 1024 * 1024) throw new Error(`Invalid cleanup manifest: ${file}`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid cleanup manifest: ${file}`);
    return value;
}

module.exports = { cleanupDownloadCache, cleanupRuntimeDirectory, managedDirectory, readCleanupManifest, renameRuntimeDirectory };
