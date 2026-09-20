const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const platform = require("../../app/platform");
const shoutcast = require("../../app/shoutcast-package");
const native = require("../../app/system-dependencies");

async function main() {
    delete process.env.LIQUIDSOAP_CI_GITHUB_TOKEN;
    assert.ok(process.argv[2] && path.isAbsolute(process.argv[2]), "Pass an absolute, isolated CI runtime directory");
    const serverRoot = process.argv[2];
    fs.mkdirSync(serverRoot, { recursive: true });
    const profile = platform.resolveProfile();
    assert.ok(["linux-x64", "freebsd-x64"].includes(profile.id));
    const binary = await shoutcast.installShoutcast({ serverRoot, acceptLicense: true });
    assert.equal(platform.resolveShoutcastBinary(serverRoot, profile).path, binary);
    const first = fs.statSync(binary).mtimeMs;
    assert.equal(await shoutcast.installShoutcast({ serverRoot }), binary);
    assert.equal(fs.statSync(binary).mtimeMs, first, "an unchanged update must not replace the binary");
    assert.equal(await shoutcast.installShoutcast({ serverRoot, force: true }), binary);
    native.assertAvailable("SHOUTcast", profile, native.inspect(binary, profile));
    assert.equal(fs.existsSync(path.join(serverRoot, "bin", "downloads", "shoutcast")), false);
    console.log(`Verified SHOUTcast installation, no-op update and reinstall: ${profile.id}`);
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `SHOUTCAST_TEST_BIN=${binary}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
