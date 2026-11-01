const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dependencies = require("../../app/dependencies");
const platform = require("../../app/platform");
const runtime = require("../../app/liquidsoap-runtime");
const releases = require("../../app/liquidsoap-releases");
const ffmpeg = require("../../app/ffmpeg-runtime");
const download = require("../../app/download");

function curl(url, args = []) {
    const result = spawnSync("curl", ["-4", "--fail", "--location", "--silent", "--show-error", "--retry", "5", "--retry-all-errors",
        "--retry-delay", "3", "--retry-max-time", "240", "--connect-timeout", "15", "--max-time", "300", ...args, url], {
        encoding: "utf8", maxBuffer: 40 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        throw new Error(`CI curl failed for ${url}: ${result.error?.message || String(result.stderr || `exit ${result.status}`).trim()}`);
    }
    return result;
}

function fixturePath(url) {
    const root = process.env.RADIOSERVER_CI_FFMPEG_FIXTURES;
    if (!root) return "";
    const parsed = new URL(url);
    return path.join(root, parsed.pathname.endsWith("/releases/") ? "releases.html" : path.basename(parsed.pathname));
}

async function fetchCatalogue(url) {
    const fixture = fixturePath(url);
    if (fixture) return { ok: true, status: 200, text: async () => fs.readFileSync(fixture, "utf8") };
    const result = curl(url);
    return { ok: true, status: 200, text: async () => result.stdout };
}

async function fetchFile({ url, filePath, maxBytes }) {
    const fixture = fixturePath(url);
    if (fixture) fs.copyFileSync(fixture, filePath);
    else curl(url, ["--output", filePath]);
    const size = fs.statSync(filePath).size;
    if (size > maxBytes) {
        fs.rmSync(filePath, { force: true });
        throw new Error(`CI download exceeds the size limit for ${url}.`);
    }
    return download.digestFile(filePath);
}

async function main() {
    // Hosted runners share public API limits. Keep the CI credential out of build processes.
    const token = process.env.LIQUIDSOAP_CI_GITHUB_TOKEN;
    delete process.env.LIQUIDSOAP_CI_GITHUB_TOKEN;
    if (token) {
        const lookup = releases.latestRelease;
        releases.latestRelease = () => lookup(undefined, async ({ url, maxBytes }) => {
            const result = curl(url, ["--header", `Authorization: Bearer ${token}`]);
            if (Buffer.byteLength(result.stdout) > maxBytes) {
                throw new Error(`CI response exceeds the size limit for ${url}.`);
            }
            return result.stdout;
        });
    }
    assert.ok(process.argv[2] && path.isAbsolute(process.argv[2]), "Pass an absolute, isolated CI runtime directory");
    const serverRoot = process.argv[2];
    fs.mkdirSync(serverRoot, { recursive: true });
    const profile = platform.resolveProfile();
    const ffmpegPlan = await ffmpeg.prepare(serverRoot, profile, { fetchImplementation: fetchCatalogue });
    const plan = await dependencies.prepareInstall({ serverRoot, validateSource: false, ffmpegPlan });
    const localFfmpeg = await ffmpeg.install(serverRoot, profile, ffmpegPlan, { fetchFile });
    const binary = await dependencies.installDependencies({ serverRoot, plan, ffmpeg: localFfmpeg });
    assert.equal(platform.resolveLiquidsoapBinary(serverRoot, platform.resolveProfile()).path, binary);
    runtime.checkVersion(binary, plan.version);
    assert.equal(runtime.checkRuntime(binary).ok, true);
    const secondFfmpegPlan = await ffmpeg.prepare(serverRoot, profile, { fetchImplementation: fetchCatalogue });
    const secondPlan = await dependencies.prepareInstall({ serverRoot, validateSource: false, ffmpegPlan: secondFfmpegPlan });
    assert.equal(secondPlan.strategy, "existing");
    assert.equal(secondFfmpegPlan.strategy, profile.family === "windows" ? "bundled" : "existing");
    const repeatedFfmpeg = await ffmpeg.install(serverRoot, profile, secondFfmpegPlan);
    assert.equal(repeatedFfmpeg?.prefix, localFfmpeg?.prefix);
    assert.equal(await dependencies.installDependencies({ serverRoot, plan: secondPlan, ffmpeg: repeatedFfmpeg }), binary);
    assert.equal(fs.existsSync(path.join(serverRoot, "bin", "downloads", "liquidsoap")), false, "successful installs remove their archive cache");
    runtime.checkVersion(binary, plan.version);
    assert.equal(runtime.checkRuntime(binary).ok, true, "cleanup must leave the installed runtime usable");
    console.log(`Verified first installation and no-op update: Liquidsoap ${plan.version} (${plan.strategy})`);
    if (process.env.GITHUB_ENV) {
        fs.appendFileSync(process.env.GITHUB_ENV, `LIQUIDSOAP_TEST_BIN=${binary}\n`);
        const resources = runtime.getResources(binary);
        if (resources) fs.appendFileSync(process.env.GITHUB_ENV, `LIQUIDSOAP_TEST_RESOURCES=${resources}\n`);
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
