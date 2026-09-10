const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

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

async function openResponse(url, signal, redirectsRemaining = 5) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Runtime downloads require HTTPS without URL credentials.");
  }
  const response = await new Promise((resolve, reject) => {
    const request = https.get(parsed, {
      signal, headers: { "User-Agent": "RadioServer runtime installer" },
    }, resolve);
    request.setTimeout(60000, () => request.destroy(new Error("Runtime download timed out.")));
    request.once("error", reject);
  });
  if (response.statusCode === 200) return response;
  response.destroy();
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    if (redirectsRemaining === 0) throw new Error("Runtime download exceeded the redirect limit.");
    return openResponse(new URL(response.headers.location, parsed), signal, redirectsRemaining - 1);
  }
  throw new Error(`Download failed with HTTP ${response.statusCode}.`);
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

module.exports = { digestFile, downloadCurrent, downloadVerified, verifyDownload };
