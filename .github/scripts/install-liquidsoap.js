const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dependencies = require("../../app/dependencies");
const platform = require("../../app/platform");
const runtime = require("../../app/liquidsoap-runtime");
const releases = require("../../app/liquidsoap-releases");
const ffmpeg = require("../../app/ffmpeg-runtime");

async function main() {
    // Hosted runners share public API limits. Keep the CI credential out of build processes.
    const token = process.env.LIQUIDSOAP_CI_GITHUB_TOKEN;
    delete process.env.LIQUIDSOAP_CI_GITHUB_TOKEN;
    if (token) {
        const lookup = releases.latestRelease;
        releases.latestRelease = () => lookup((url, options) => globalThis.fetch(url, {
            ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
        }));
    }
    assert.ok(process.argv[2] && path.isAbsolute(process.argv[2]), "Pass an absolute, isolated CI runtime directory");
    const serverRoot = process.argv[2];
    fs.mkdirSync(serverRoot, { recursive: true });
    const profile = platform.resolveProfile();
    const plan = await dependencies.prepareInstall({ serverRoot, validateSource: false });
    const ffmpegPlan = await ffmpeg.prepare(serverRoot, profile);
    const localFfmpeg = await ffmpeg.install(serverRoot, profile, ffmpegPlan);
    const binary = await dependencies.installDependencies({ serverRoot, plan, ffmpeg: localFfmpeg });
    assert.equal(platform.resolveLiquidsoapBinary(serverRoot, platform.resolveProfile()).path, binary);
    runtime.checkVersion(binary, plan.version);
    assert.equal(runtime.checkRuntime(binary).ok, true);
    const secondPlan = await dependencies.prepareInstall({ serverRoot, validateSource: false });
    const secondFfmpegPlan = await ffmpeg.prepare(serverRoot, profile);
    const repeatedFfmpeg = await ffmpeg.install(serverRoot, profile, secondFfmpegPlan);
    assert.equal(repeatedFfmpeg?.prefix, localFfmpeg?.prefix);
    assert.equal(await dependencies.installDependencies({ serverRoot, plan: secondPlan, ffmpeg: repeatedFfmpeg }), binary);
    console.log(`Verified installation and repeat installation: Liquidsoap ${plan.version} (${plan.strategy})`);
    if (process.env.GITHUB_ENV) {
        fs.appendFileSync(process.env.GITHUB_ENV, `LIQUIDSOAP_TEST_BIN=${binary}\n`);
        const resources = runtime.getResources(binary);
        if (resources) fs.appendFileSync(process.env.GITHUB_ENV, `LIQUIDSOAP_TEST_RESOURCES=${resources}\n`);
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
