const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dependencies = require("../../app/dependencies");
const platform = require("../../app/platform");
const runtime = require("../../app/liquidsoap-runtime");

async function main() {
    assert.ok(process.argv[2] && path.isAbsolute(process.argv[2]), "Pass an absolute, isolated CI runtime directory");
    const serverRoot = process.argv[2];
    fs.mkdirSync(serverRoot, { recursive: true });
    const plan = await dependencies.prepareInstall({ serverRoot });
    const binary = await dependencies.installDependencies({ serverRoot, plan });
    assert.equal(platform.resolveLiquidsoapBinary(serverRoot, platform.resolveProfile()).path, binary);
    runtime.checkVersion(binary, plan.version);
    assert.equal(runtime.checkRuntime(binary).ok, true);
    const secondPlan = await dependencies.prepareInstall({ serverRoot });
    assert.equal(await dependencies.installDependencies({ serverRoot, plan: secondPlan }), binary);
    console.log(`Verified installation and repeat installation: Liquidsoap ${plan.version} (${plan.strategy})`);
    if (process.env.GITHUB_ENV) {
        fs.appendFileSync(process.env.GITHUB_ENV, `LIQUIDSOAP_TEST_BIN=${binary}\n`);
        const resources = runtime.getResources(binary);
        if (resources) fs.appendFileSync(process.env.GITHUB_ENV, `LIQUIDSOAP_TEST_RESOURCES=${resources}\n`);
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
