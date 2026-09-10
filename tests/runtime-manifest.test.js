const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readRuntimeManifest } = require("../app/runtime-manifest");

test("runtime manifests tolerate missing or invalid metadata without inventing a checksum", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-runtime-manifest-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime.json");
  assert.deepEqual(readRuntimeManifest(file), {});
  for (const contents of ["null", "[]", "false", "42", '"text"', "{broken"]) {
    fs.writeFileSync(file, contents);
    assert.deepEqual(readRuntimeManifest(file), {}, contents);
  }
  const manifest = { url: "https://example.com/runtime.deb", sha256: "a".repeat(64) };
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.deepEqual(readRuntimeManifest(file), manifest);
});

test("runtime manifest read failures are not mistaken for an uninstalled runtime", (context) => {
  context.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
  assert.throws(() => readRuntimeManifest("runtime.json"), /Cannot read runtime manifest.*permission denied/);
});
