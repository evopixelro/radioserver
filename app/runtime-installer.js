const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dependencies = require("./dependencies");
const opam = require("./liquidsoap-opam");
const ffmpeg = require("./ffmpeg-runtime");
const platform = require("./platform");
const shoutcast = require("./shoutcast-package");
const systemDependencies = require("./system-dependencies");

const COLORS = {
    green: "\u001b[32m",
    red: "\u001b[31m",
    yellow: "\u001b[33m",
    reset: "\u001b[0m",
};

function colorize(value, color, enabled) {
    return enabled ? `${COLORS[color]}${value}${COLORS.reset}` : value;
}

function getRuntimeStatus(serverRoot = path.resolve(__dirname, "..")) {
    const runtimeProfile = platform.resolveProfile();
    const shoutcastBinary = platform.resolveShoutcastBinary(serverRoot, runtimeProfile);
    const dependencyStatus = dependencies.getDependencyStatus({ serverRoot, runtimeProfile });
    const shoutcastLibraries = shoutcastBinary.found
        ? systemDependencies.inspect(shoutcastBinary.path, runtimeProfile) : null;
    return {
        dependencyStatus,
        shoutcastBinary,
        items: [
            { label: "Node.js", found: true, detail: process.version },
            {
                label: "SHOUTcast",
                found: shoutcastBinary.found,
                detail: shoutcastBinary.found ? shoutcastBinary.path : "not found",
            },
            ...systemDependencies.statusItems("SHOUTcast", shoutcastLibraries),
            ...dependencyStatus.items,
        ],
        runtimeProfile,
        shoutcastLibraries,
    };
}

function printRuntimeStatus(status, {
    color = Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env),
} = {}) {
    const printItem = (item, indent = "  ") => {
        const marker = item.found ? "FOUND" : "MISSING";
        const renderedMarker = colorize(marker, item.found ? "green" : "red", color);
        console.log(`${indent}${renderedMarker} ${item.label}: ${item.detail}`);
    };
    const requirements = status.systemRequirements;
    if (requirements) {
        const name = { linux: "Linux", windows: "Windows", macos: "macOS", freebsd: "FreeBSD" }[status.runtimeProfile.family] || status.runtimeProfile.id;
        console.log(`${name} system dependencies (SHOUTcast and Liquidsoap):`);
        systemDependencies.printStatus("SHOUTcast", status.shoutcastLibraries, { color });
        systemDependencies.printStatus("Liquidsoap", status.dependencyStatus?.nativeLibraries, { color });
        console.log(`  ${requirements.reason}:`);
        for (const item of requirements.items) {
            if (!/^(native|abi|inspection):/.test(item.id || "")) printItem(item, "    ");
        }
        if (requirements.note) console.log(`    ${requirements.note}`);
        if (requirements.archiveItems?.length) {
            console.log("  SHOUTcast installation tools (not runtime libraries):");
            for (const item of requirements.archiveItems) printItem(item, "    ");
        }
        if (requirements.ffmpegItems?.length) {
            console.log("  FFmpeg local build:");
            for (const item of requirements.ffmpegItems) printItem(item, "    ");
        }
        if (requirements.sourceMissing) console.log(systemDependencies.sourceInstallationHelp(status.runtimeProfile, { color, managedFfmpeg: requirements.managedFfmpeg }));
        if (requirements.ffmpegMissing) console.log(systemDependencies.ffmpegInstallationHelp(status.runtimeProfile, { color }));
        if (requirements.extractionMissing) {
            console.log("Install the package extraction tool separately (Debian/Ubuntu):");
            console.log(colorize("sudo apt-get install dpkg", "yellow", color));
        }
        if (requirements.archiveMissing?.length) {
            console.log(systemDependencies.archiveInstallationHelp(status.runtimeProfile, requirements.archiveMissing, { color }));
        }
        const hints = new Set();
        for (const report of [status.shoutcastLibraries, status.dependencyStatus?.nativeLibraries]) {
            if (report && (report.missing.length || report.abiError)) {
                hints.add(systemDependencies.installationHelp({ ...status.runtimeProfile, architecture: report.architecture || status.runtimeProfile.architecture }, {
                    missing: report.missing, abiError: report.abiError, debianDepends: report.debianDepends, color,
                }));
            }
        }
        if (!requirements.managedFfmpeg && status.dependencyStatus?.missing?.includes("ffmpeg") && status.runtimeProfile.family !== "windows") {
            hints.add(systemDependencies.installationHelp(status.runtimeProfile, { ffmpeg: true, color }));
        }
        for (const hint of hints) console.log(hint);
        console.log("");
    }
    console.log(`Runtime requirements for ${status.runtimeProfile.id}:`);
    for (const item of status.items) {
        if (!requirements || !/^(native|abi|inspection):/.test(item.id || "")) printItem(item);
    }
}

function getInstallRequirements(status, plan, { run = spawnSync, systemRoot = process.env.SystemRoot } = {}) {
    const nativeItems = [
        ...systemDependencies.statusItems("SHOUTcast", status.shoutcastLibraries),
        ...systemDependencies.statusItems("Liquidsoap", status.dependencyStatus?.nativeLibraries),
    ];
    if (plan.strategy === "source") {
        const report = opam.inspectPrerequisites(status.runtimeProfile, { run, managedFfmpeg: plan.managedFfmpeg });
        return { ...report, items: [...nativeItems, ...report.items],
            sourceMissing: report.items.some((item) => !item.found), reason: "Liquidsoap source build",
            ...(plan.managedFfmpeg ? { note: "FFmpeg development libraries will be provided by the managed local FFmpeg build." } : {}) };
    }
    if (plan.strategy === "binary" && status.runtimeProfile.family === "linux") {
        const result = run("dpkg-deb", ["--version"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true,
        });
        const found = !result.error && result.status === 0;
        return {
            reason: "official Liquidsoap binary",
            items: [...nativeItems, { label: "dpkg-deb", found, detail: found ? "available for package extraction" : "not found or could not run" }],
            note: "OPAM and development libraries are not required; native runtime libraries are checked separately.",
            extractionMissing: !found,
            error: found ? "" : "Liquidsoap package extraction requires dpkg-deb. Install dpkg and retry; no runtimes were replaced.",
        };
    }
    if (plan.strategy === "unknown") return { reason: "installed runtimes", items: nativeItems,
        note: "Build requirements could not be selected; see the installation error below." };
    const bundledWindows = status.runtimeProfile.family === "windows" && plan.strategy === "binary";
    if (bundledWindows) {
        const executable = systemRoot && path.win32.isAbsolute(systemRoot) ? path.win32.join(systemRoot, "System32", "tar.exe") : null;
        const result = executable ? run(executable, ["--version"], {
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true,
        }) : null;
        const found = Boolean(result && !result.error && result.status === 0);
        return {
            reason: "official Liquidsoap binary",
            items: [...nativeItems, { label: "Liquidsoap archive extractor (Windows tar.exe)", found,
                detail: found ? executable : "native Windows archive extractor is unavailable" }],
            note: "FFmpeg is bundled with Liquidsoap. Native DLLs are checked when the executable is available; OPAM and development libraries are not required.",
            error: found ? "" : "Restore the Windows system tar.exe component and ensure SystemRoot points to Windows; a Git Bash tar is not a compatible substitute. No runtimes were replaced.",
        };
    }
    return { reason: "existing Liquidsoap runtime", items: nativeItems,
        note: "No compilation tools are required. Native libraries are checked for each available executable." };
}

async function installRuntime({
    acceptLicense = false,
    force = false,
    serverRoot = path.resolve(__dirname, ".."),
} = {}) {
    const radio = require("./process-manager");
    const autodj = require("./autodj-manager");
    const configuration = require("./config");
    const runDirectory = path.resolve(serverRoot, process.env.RADIO_RUN_DIR || ".run");
    const radioConfig = { ...configuration, serverRoot, pidPath: path.join(runDirectory, "sc_serv.pid"),
        binaryPath: platform.resolveShoutcastBinary(serverRoot, platform.resolveProfile()).path };
    if (radio.getStatus(radioConfig).running || autodj.status(autodj.getConfig(serverRoot)).running) {
        throw new Error("Stop SHOUTcast and AutoDJ before installing or updating runtimes: npm run autodj:stop, then npm run stop.");
    }
    console.log(force ? "Updating managed radio runtimes..." : "Installing radio runtimes...");
    const status = getRuntimeStatus(serverRoot);
    let plan;
    let ffmpegPlan;
    try {
        for (const binary of [status.shoutcastBinary, status.dependencyStatus.liquidsoap]) {
            if (!binary.found && ["SC_SERV_BIN", "LIQUIDSOAP_BIN"].includes(binary.source)) {
                throw new Error(`${binary.source} does not point to an existing executable: ${binary.path}. Correct the path or unset ${binary.source} to use the managed runtime.`);
            }
        }
        if (!status.shoutcastBinary.found && !shoutcast.getPackage(status.runtimeProfile, serverRoot)) {
            throw new Error(`No current official SHOUTcast package is available for ${status.runtimeProfile.id}; the complete radio stack cannot be installed on this host. Supply a compatible licensed SHOUTcast executable through SC_SERV_BIN before installing AutoDJ, or use a platform supported by both engines.`);
        }
        // Select the exact installation path before requiring any source-build tools.
        plan = await dependencies.prepareInstall({ force, serverRoot, runtimeProfile: status.runtimeProfile,
            existingBinary: status.dependencyStatus.liquidsoap, validateSource: false });
        plan.managedFfmpeg = status.runtimeProfile.family !== "windows";
        status.systemRequirements = getInstallRequirements(status, plan);
        status.systemRequirements.managedFfmpeg = plan.managedFfmpeg;
        const archive = shoutcast.getInstallRequirements(status.runtimeProfile, status.shoutcastBinary);
        status.systemRequirements.archiveItems = archive.items;
        status.systemRequirements.archiveMissing = archive.missing;
        if (archive.missing.length) {
            status.systemRequirements.error ||= `SHOUTcast extraction requires: ${archive.missing.join(", ")}. Install the missing tools and retry; no runtimes were replaced.`;
        }
        ffmpegPlan = await ffmpeg.prepare(serverRoot, status.runtimeProfile);
        if (ffmpegPlan.strategy === "source") {
            const report = ffmpeg.inspectPrerequisites(status.runtimeProfile);
            status.systemRequirements.ffmpegItems = report.items;
            status.systemRequirements.ffmpegMissing = report.items.some((item) => !item.found);
            status.systemRequirements.error ||= report.error;
        }
    } finally {
        // Even selection failures must leave the current runtime status visible.
        status.systemRequirements ||= getInstallRequirements(status, { strategy: "unknown" });
        printRuntimeStatus(status);
    }
    if (status.systemRequirements?.error) throw new Error(status.systemRequirements.error);
    const repairShoutcast = status.runtimeProfile.family === "windows" && status.shoutcastBinary.source === "platform" &&
        (status.shoutcastLibraries?.missing.length > 0 || Boolean(status.shoutcastLibraries?.inspectionError)) && !status.shoutcastLibraries.abiError &&
        !status.shoutcastLibraries.missing.some((name) => /^(?:vcruntime|msvcp|concrt)/i.test(name));
    if (!repairShoutcast) systemDependencies.assertAvailable("SHOUTcast", status.runtimeProfile, status.shoutcastLibraries);
    dependencies.preflightInstall({
        dependencyStatus: status.dependencyStatus,
        existingBinary: status.dependencyStatus.liquidsoap,
        force,
        runtimeProfile: status.runtimeProfile,
        serverRoot,
        managedFfmpeg: plan.managedFfmpeg,
    });
    const localFfmpeg = await ffmpeg.install(serverRoot, status.runtimeProfile, ffmpegPlan);
    await shoutcast.installShoutcast({ acceptLicense, force: force || repairShoutcast, serverRoot });
    await dependencies.installDependencies({ force, serverRoot, plan, ...(localFfmpeg ? { ffmpeg: localFfmpeg } : {}) });
    console.log(force ? "Managed runtime update completed." : "Runtime installation completed.");
}

module.exports = { getInstallRequirements, getRuntimeStatus, installRuntime, printRuntimeStatus };
