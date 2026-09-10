const path = require("node:path");
const dependencies = require("./dependencies");
const platform = require("./platform");
const shoutcast = require("./shoutcast-package");
const systemDependencies = require("./system-dependencies");

const COLORS = {
  green: "\u001b[32m",
  red: "\u001b[31m",
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
  console.log(`Runtime requirements for ${status.runtimeProfile.id}:`);
  for (const item of status.items) {
    const marker = item.found ? "FOUND" : "MISSING";
    const renderedMarker = colorize(marker, item.found ? "green" : "red", color);
    console.log(`  ${renderedMarker} ${item.label}: ${item.detail}`);
  }
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
  printRuntimeStatus(status);
  for (const binary of [status.shoutcastBinary, status.dependencyStatus.liquidsoap]) {
    if (!binary.found && ["SC_SERV_BIN", "LIQUIDSOAP_BIN"].includes(binary.source)) {
      throw new Error(`${binary.source} does not point to an existing executable: ${binary.path}. Correct the path or unset ${binary.source} to use the managed runtime.`);
    }
  }
  if (!status.shoutcastBinary.found && !shoutcast.getPackage(status.runtimeProfile, serverRoot)) {
    throw new Error(`No current official SHOUTcast package is available for ${status.runtimeProfile.id}; the complete radio stack cannot be installed on this host. Supply a compatible licensed SHOUTcast executable through SC_SERV_BIN before installing AutoDJ, or use a platform supported by both engines.`);
  }
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
  });
  await shoutcast.installShoutcast({ acceptLicense, force: force || repairShoutcast, serverRoot });
  await dependencies.installDependencies({ force, serverRoot });
  console.log(force ? "Managed runtime update completed." : "Runtime installation completed.");
}

module.exports = { getRuntimeStatus, installRuntime, printRuntimeStatus };
