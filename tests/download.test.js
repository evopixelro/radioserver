const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { downloadVerified, verifyDownload } = require("../app/download");

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
