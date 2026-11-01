const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const { downloadVerified, readText, verifyDownload } = require("../app/download");

test("accepts a cached runtime only when its pinned SHA-256 matches", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-download-"));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "runtime.bin");
    const content = Buffer.from("verified runtime package");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    fs.writeFileSync(filePath, content);

    assert.equal(verifyDownload({ filePath, sha256 }), true);
    assert.equal(
        await downloadVerified({ filePath, sha256, url: "https://example.invalid/runtime.bin" }),
        filePath,
    );
    assert.throws(
        () => verifyDownload({ filePath, sha256: "0".repeat(64) }),
        /checksum mismatch/,
    );
});

test("retries runtime HTTPS requests over IPv4 after a dual-stack connection failure", async (context) => {
    const families = [];
    context.mock.method(https, "get", (_url, options, callback) => {
        const request = new EventEmitter();
        request.setTimeout = () => {};
        request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
        families.push(options.family || 0);
        if (!options.family) {
            queueMicrotask(() => {
                const error = new Error("IPv6 route unavailable");
                error.code = "ENETUNREACH";
                request.emit("error", error);
            });
        } else {
            const response = Readable.from([Buffer.from("runtime catalogue")]);
            response.statusCode = 200;
            response.headers = {};
            queueMicrotask(() => callback(response));
        }
        return request;
    });

    assert.equal(await readText({ url: "https://example.invalid/runtime.txt" }), "runtime catalogue");
    assert.deepEqual(families, [0, 4]);
});

test("rejects malformed package digests before attempting a download", async () => {
    await assert.rejects(
        downloadVerified({
            filePath: path.join(os.tmpdir(), "radioserver-invalid-digest.bin"),
            sha256: "invalid",
            url: "https://example.invalid/runtime.bin",
        }),
        /Invalid pinned SHA-256/,
    );
});
