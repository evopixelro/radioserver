const fs = require("node:fs");
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

module.exports = { cleanupRuntimeDirectory, renameRuntimeDirectory };
