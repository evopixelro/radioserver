const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const download = require("./download");
const platform = require("./platform");
const systemDependencies = require("./system-dependencies");
const { readRuntimeManifest } = require("./runtime-manifest");
const { cleanupRuntimeDirectory } = require("./runtime-cleanup");

const LICENSE_URL = "https://www.shoutcast.com/legal/agreements/dnas";
const SHOUTCAST_PACKAGES = {
  "linux-x64": {
    kind: "archive",
    fileName: "sc_serv2_linux_x64-latest.tar.gz",
    url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_linux_x64-latest.tar.gz",
  },
  "linux-x86": {
    kind: "archive",
    fileName: "sc_serv2_linux_x86-latest.tar.gz",
    url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_linux-latest.tar.gz",
  },
  "windows-x64": {
    kind: "installer",
    fileName: "sc_serv2_win64-latest.exe",
    url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_win64-latest.exe",
  },
  "windows-x86": {
    kind: "installer",
    fileName: "sc_serv2_win32-latest.exe",
    url: "https://download.nullsoft.com/shoutcast/tools/sc_serv2_win32-latest.exe",
  },
};

function getPackage(runtimeProfile, serverRoot = path.resolve(__dirname, "..")) {
  const specification = SHOUTCAST_PACKAGES[runtimeProfile.id];
  if (!specification) return null;
  return {
    ...specification,
    filePath: path.join(
      serverRoot,
      "bin",
      "downloads",
      "shoutcast",
      specification.fileName,
    ),
  };
}

function verifyPackage(packageInfo) {
  if (!packageInfo) throw new Error("No SHOUTcast package was selected.");
  return download.verifyDownload({
    filePath: packageInfo.filePath,
    sha256: packageInfo.sha256,
    label: packageInfo.fileName,
  });
}

async function downloadPackage(packageInfo) {
  packageInfo.sha256 = await download.downloadCurrent(packageInfo);
  return packageInfo.filePath;
}

function ensureLicenseAccepted(accepted, serverRoot) {
  const licensePath = path.join(serverRoot, "bin", "shoutcast", "license.json");
  try {
    const saved = JSON.parse(fs.readFileSync(licensePath, "utf8"));
    if (saved?.accepted === true && saved.licenseUrl === LICENSE_URL) return;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!accepted) {
    throw new Error(
      "SHOUTcast license acceptance is not recorded. " +
        "Use 'npm run install' or 'npm run update', which already include --accept-license. " +
        "For a direct Node.js command, add --accept-license. " +
        `License: ${LICENSE_URL}`,
    );
  }

  fs.mkdirSync(path.dirname(licensePath), { recursive: true, mode: 0o750 });
  const temporaryPath = `${licensePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({
      accepted: true,
      licenseUrl: LICENSE_URL,
      acceptedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o640 });
    fs.renameSync(temporaryPath, licensePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function installLinuxPackage(packageInfo, serverRoot, runtimeProfile) {
  const installDirectory = path.join(serverRoot, "bin", "shoutcast", runtimeProfile.id);
  fs.mkdirSync(path.dirname(installDirectory), { recursive: true, mode: 0o750 });
  const staging = fs.mkdtempSync(path.join(path.dirname(installDirectory), `${runtimeProfile.id}.tmp-`));
  try {
    const result = spawnSync("tar", ["-xf", packageInfo.filePath, "-C", staging], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`SHOUTcast archive extraction failed with status ${result.status}.`);
    }

    const binaryPath = path.join(staging, "sc_serv");
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`SHOUTcast archive did not contain the expected executable: ${binaryPath}`);
    }
    fs.chmodSync(binaryPath, 0o755);
    systemDependencies.assertAvailable("SHOUTcast", runtimeProfile, systemDependencies.inspect(binaryPath, runtimeProfile));
    const backup = `${staging}-previous`;
    const existed = fs.existsSync(installDirectory);
    if (existed) fs.renameSync(installDirectory, backup);
    try {
      fs.renameSync(staging, installDirectory);
    } catch (error) {
      if (existed) fs.renameSync(backup, installDirectory);
      throw error;
    }
    if (existed) cleanupRuntimeDirectory(backup);
    console.log(`SHOUTcast installed for ${runtimeProfile.id}: ${path.join(installDirectory, "sc_serv")}`);
    return path.join(installDirectory, "sc_serv");
  } finally {
    cleanupRuntimeDirectory(staging);
  }
}

function installWindowsPackage(packageInfo, serverRoot, runtimeProfile) {
  const installDirectory = path.join(serverRoot, "bin", "shoutcast", runtimeProfile.id);
  console.log(`Opening the official SHOUTcast ${runtimeProfile.architecture} installer:`);
  console.log(packageInfo.filePath);
  console.log(`Suggested installation directory: ${installDirectory}`);
  console.log("If you choose another directory, set SC_SERV_BIN to the full executable path.");
  const result = spawnSync(packageInfo.filePath, [`/D=${installDirectory}`], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`SHOUTcast installer exited with status ${result.status}.`);
  }

  const binary = platform.resolveShoutcastBinary(serverRoot, runtimeProfile);
  if (!binary.found) {
    throw new Error("Installation completed, but sc_serv.exe was not found; set SC_SERV_BIN.");
  }
  systemDependencies.assertAvailable("SHOUTcast", runtimeProfile, systemDependencies.inspect(binary.path, runtimeProfile));
  console.log(`SHOUTcast executable detected: ${binary.path}`);
  return binary.path;
}

async function installShoutcast({
  acceptLicense = false,
  force = false,
  serverRoot = path.resolve(__dirname, ".."),
} = {}) {
  const runtimeProfile = platform.resolveProfile();
  const existing = platform.resolveShoutcastBinary(serverRoot, runtimeProfile);
  const packageInfo = getPackage(runtimeProfile, serverRoot);
  if (existing.found && (!packageInfo || ["PATH", "SC_SERV_BIN", "external"].includes(existing.source))) {
    if (force) {
      console.log(`SHOUTcast is externally managed and was not modified: ${existing.path}`);
      return existing.path;
    }
    console.log(`SHOUTcast is already available for ${runtimeProfile.id}: ${existing.path}`);
    return existing.path;
  }

  if (!packageInfo) {
    throw new Error(
      `No current official SHOUTcast package is published for ${runtimeProfile.id}. Set SC_SERV_BIN to a compatible executable.`,
    );
  }
  ensureLicenseAccepted(acceptLicense, serverRoot);
  console.log(`Downloading SHOUTcast from its official distribution host for ${runtimeProfile.id}...`);
  await downloadPackage(packageInfo);
  const manifestPath = path.join(serverRoot, "bin", "shoutcast", runtimeProfile.id, "runtime.json");
  const installed = readRuntimeManifest(manifestPath);
  if (existing.found && installed.sha256 === packageInfo.sha256 && !force) {
    console.log(`SHOUTcast already matches the official latest download: ${existing.path}`);
    return existing.path;
  }
  const binary = packageInfo.kind === "archive"
    ? installLinuxPackage(packageInfo, serverRoot, runtimeProfile)
    : installWindowsPackage(packageInfo, serverRoot, runtimeProfile);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o750 });
  fs.writeFileSync(manifestPath, `${JSON.stringify({ url: packageInfo.url, sha256: packageInfo.sha256 }, null, 2)}\n`, { mode: 0o640 });
  return binary;
}

module.exports = {
  LICENSE_URL,
  SHOUTCAST_PACKAGES,
  downloadPackage,
  getPackage,
  installShoutcast,
  verifyPackage,
};
