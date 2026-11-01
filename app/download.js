const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const IPV4_RETRY_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT", "RADIO_CONNECT_TIMEOUT"]);

function digestFile(filePath) {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(filePath, "r");
    try {
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, count));
        }
        return hash.digest("hex");
    } finally {
        fs.closeSync(fd);
    }
}

function verifyDownload({ filePath, sha256, label = path.basename(filePath) }) {
    if (!fs.existsSync(filePath)) throw new Error(`Downloaded file is missing: ${filePath}`);
    const digest = digestFile(filePath);
    if (digest !== sha256) {
        throw new Error(`${label} checksum mismatch. Expected ${sha256}, received ${digest}.`);
    }
    return true;
}

function shouldRetryIpv4(error) {
    const errors = [error, ...(Array.isArray(error?.errors) ? error.errors : [])];
    return errors.some((item) => IPV4_RETRY_CODES.has(item?.code));
}

async function requestResponse(parsed, signal, family) {
    return new Promise((resolve, reject) => {
        let connectionTimer;
        const request = https.get(parsed, {
            signal, headers: { "User-Agent": "RadioServer runtime installer" }, ...(family ? { family } : {}),
        }, (response) => {
            clearTimeout(connectionTimer);
            resolve(response);
        });
        connectionTimer = setTimeout(() => {
            const error = new Error("Runtime connection timed out.");
            error.code = "RADIO_CONNECT_TIMEOUT";
            request.destroy(error);
        }, 10000);
        connectionTimer.unref();
        request.once("error", (error) => {
            clearTimeout(connectionTimer);
            reject(error);
        });
    });
}

async function openResponse(url, signal, redirectsRemaining = 5, family) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Runtime downloads require HTTPS without URL credentials.");
    }
    let response;
    try {
        response = await requestResponse(parsed, signal, family);
    } catch (error) {
        if (!family && !signal.aborted && shouldRetryIpv4(error)) {
            return openResponse(parsed, signal, redirectsRemaining, 4);
        }
        throw error;
    }
    if (response.statusCode === 200) return response;
    response.destroy();
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (redirectsRemaining === 0) throw new Error("Runtime download exceeded the redirect limit.");
        return openResponse(new URL(response.headers.location, parsed), signal, redirectsRemaining - 1);
    }
    throw new Error(`Download failed with HTTP ${response.statusCode}.`);
}

async function readText({ url, timeoutMs = 30000, maxBytes = 4 * 1024 * 1024 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Runtime request timed out.")), timeoutMs);
    timer.unref();
    let response;
    try {
        response = await openResponse(url, controller.signal);
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
            size += chunk.length;
            if (size > maxBytes) throw new Error("Runtime response exceeds the size limit.");
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, size).toString("utf8");
    } finally {
        clearTimeout(timer);
        response?.destroy();
    }
}

async function replaceDownload({ filePath, url, sha256, label, timeoutMs = 300000, maxBytes = 1024 ** 3 }) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
    const temporaryPath = `${filePath}.part-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Runtime download timed out.")), timeoutMs);
    timer.unref();
    let response;
    try {
        response = await openResponse(url, controller.signal);
        let size = 0;
        const limit = new Transform({
            transform(chunk, encoding, callback) {
                size += chunk.length;
                callback(size > maxBytes ? new Error("Runtime download exceeds the size limit.") : null, chunk);
            },
        });
        const output = fs.createWriteStream(temporaryPath, {
            fd: fs.openSync(temporaryPath, "wx", 0o600), autoClose: true,
        });
        await pipeline(response, limit, output, { signal: controller.signal });
        if (!size) throw new Error("Runtime download is empty.");
        if (sha256) verifyDownload({ filePath: temporaryPath, sha256, label: label || path.basename(filePath) });
        const digest = sha256 || digestFile(temporaryPath);
        fs.renameSync(temporaryPath, filePath);
        return digest;
    } finally {
        clearTimeout(timer);
        response?.destroy();
        fs.rmSync(temporaryPath, { force: true });
    }
}

async function downloadVerified(options) {
    const { filePath, force = false, label, sha256 } = options;
    if (!/^[a-f0-9]{64}$/.test(String(sha256))) {
        throw new Error(`Invalid pinned SHA-256 digest for ${label || path.basename(filePath)}.`);
    }
    if (!force && fs.existsSync(filePath)) {
        try {
            verifyDownload({ filePath, sha256, label });
            return filePath;
        } catch (error) {
            if (!error.message.includes("checksum mismatch")) throw error;
        }
    }
    await replaceDownload(options);
    return filePath;
}

async function downloadCurrent(options) {
    return replaceDownload(options);
}

module.exports = { digestFile, downloadCurrent, downloadVerified, readText, verifyDownload };
