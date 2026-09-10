const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const process = require("node:process");
const download = require("./download");
const platform = require("./platform");
const liquidsoapRuntime = require("./liquidsoap-runtime");
const releases = require("./liquidsoap-releases");
const systemDependencies = require("./system-dependencies");
const { readRuntimeManifest } = require("./runtime-manifest");
const { cleanupRuntimeDirectory } = require("./runtime-cleanup");

const LIQUIDSOAP_PACKAGES = [
  {
    distribution: "debian",
    codename: "bookworm",
    architecture: "x64",
    fileName: "liquidsoap_2.4.0-debian-bookworm-amd64.deb",
    url: "https://github.com/savonet/liquidsoap-release-assets/releases/download/v2.4.0/liquidsoap_2.4.0-debian-bookworm-ocaml4.14.2-3_amd64.deb",
    sha256: "aba2faba564147c338e38f7b30f266227c17b5b53ab1f7cf5460e5acd93d368f",
  },
  {
    distribution: "debian",
    codename: "trixie",
    architecture: "x64",
    fileName: "liquidsoap_2.4.5-debian-trixie-amd64.deb",
    url: "https://github.com/savonet/liquidsoap-release-assets/releases/download/v2.4.5/liquidsoap_2.4.5-debian-trixie-ocaml4.14.2-2_amd64.deb",
    sha256: "44d860cf64d203c4bb4c5e2925bd81e697b9ca6e7cbce0dad624d78e51eea118",
  },
  {
    distribution: "ubuntu",
    codename: "jammy",
    architecture: "x64",
    fileName: "liquidsoap_2.2.5-ubuntu-jammy-amd64.deb",
    url: "https://github.com/savonet/liquidsoap-release-assets/releases/download/v2.2.5/liquidsoap_2.2.5-ubuntu-jammy-1_amd64.deb",
    sha256: "754f1c5d85f5a467d77c46d565abd6a79d98747b1675b2c49679668b4f2f26e2",
  },
  {
    distribution: "ubuntu",
    codename: "noble",
    architecture: "x64",
    fileName: "liquidsoap_2.4.5-ubuntu-noble-amd64.deb",
    url: "https://github.com/savonet/liquidsoap-release-assets/releases/download/v2.4.5/liquidsoap_2.4.5-ubuntu-noble-ocaml4.14.2-2_amd64.deb",
    sha256: "1e0233bf152baffdaa0fb61d8c86d4879cab440d5310711242897b9bc739b943",
  },
];

const WINDOWS_LIQUIDSOAP_PACKAGE = {
  family: "windows",
  architecture: "x64",
  fileName: "liquidsoap-2.4.5-win64.zip",
  directoryName: "liquidsoap-2.4.5-win64",
  url: "https://github.com/savonet/liquidsoap-release-assets/releases/download/v2.4.5/liquidsoap-2.4.5-win64.zip",
  sha256: "17c29c9f662db11ced6b85e807f6038e15e32b76f30f9695506905879a43f4b6",
};

function commandExists(command, versionArguments = ["--version"]) {
  const result = spawnSync(command, versionArguments, { stdio: "ignore", timeout: 15000, windowsHide: true });
  return !result.error && result.status === 0;
}

function isDebianFamily() {
  return process.platform === "linux" && commandExists("apt-get") && commandExists("dpkg-query");
}

function debianPackageIsInstalled(packageName) {
  const result = spawnSync("dpkg-query", ["-W", "-f=${Status}", packageName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15000, windowsHide: true,
  });
  return result.status === 0 && /\binstall ok installed\b/.test(result.stdout || "");
}

function debianPackageOwnsBinary(binary, run = spawnSync) {
  const result = run("dpkg-query", ["-S", fs.realpathSync(binary)], {
    encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0 && /^liquidsoap(?::[^:\s]+)?:\s/m.test(result.stdout || "");
}

function getLinuxInstallPlan({ existing, systemPackageInstalled }) {
  const externallyManagedLiquidsoap =
    existing.found &&
    (
      existing.source === "LIQUIDSOAP_BIN" ||
      (existing.source === "PATH" && !systemPackageInstalled)
    );
  return {
    externallyManagedLiquidsoap,
  };
}

function parseOsRelease(content) {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return {
    distribution: (values.ID || "").toLowerCase(),
    codename: (values.VERSION_CODENAME || values.UBUNTU_CODENAME || "").toLowerCase(),
  };
}

function readOsRelease() {
  try {
    return parseOsRelease(fs.readFileSync("/etc/os-release", "utf8"));
  } catch {
    return { distribution: "", codename: "" };
  }
}

function activateRuntime(stagingRoot, runtimeRoot) {
  const backup = `${runtimeRoot}.previous-${randomUUID()}`;
  const existed = fs.existsSync(runtimeRoot);
  if (existed) fs.renameSync(runtimeRoot, backup);
  try {
    fs.renameSync(stagingRoot, runtimeRoot);
  } catch (error) {
    if (existed) {
      try {
        fs.renameSync(backup, runtimeRoot);
      } catch (rollbackError) {
        throw new Error(
          `Liquidsoap activation failed: ${error.message}. Restoration also failed: ${rollbackError.message}. ` +
          `The previous runtime is preserved at ${backup}. Restore it before starting AutoDJ or retrying the update.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  if (existed) cleanupRuntimeDirectory(backup);
}

function extractLinuxPackage(packageInfo, serverRoot, runtimeProfile, {
  run = spawnSync,
  validate = liquidsoapRuntime.checkRuntime,
} = {}) {
  verifyPackage(packageInfo);
  const parent = path.join(serverRoot, "bin", "liquidsoap");
  fs.mkdirSync(parent, { recursive: true, mode: 0o750 });
  const runtimeRoot = path.join(parent, runtimeProfile.id);
  const stagingRoot = fs.mkdtempSync(path.join(parent, `${runtimeProfile.id}.tmp-`));
  try {
    const result = run("dpkg-deb", ["--extract", packageInfo.filePath, stagingRoot], { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error(`Liquidsoap extraction failed: ${result.error?.message || result.status}.`);
    }
    const binary = path.join(stagingRoot, "usr", "bin", "liquidsoap");
    const stdlib = path.join(stagingRoot, "usr", "share", "liquidsoap", "libs", "stdlib.liq");
    if (!fs.existsSync(binary) || !fs.existsSync(stdlib)) {
      throw new Error("Liquidsoap package is incomplete: executable or stdlib.liq is missing.");
    }
    fs.chmodSync(binary, 0o755);
    fs.writeFileSync(path.join(stagingRoot, "runtime.json"), `${JSON.stringify({
      version: packageInfo.version,
      sha256: packageInfo.sha256,
      url: packageInfo.url,
    }, null, 2)}\n`, { mode: 0o640 });
    const check = validate(binary);
    if (!check.ok) {
      if (/shared librar|shared object|version .+not found|ENOENT/i.test(check.detail)) {
        const dependencies = run("dpkg-deb", ["--field", packageInfo.filePath, "Depends"], { encoding: "utf8" });
        const expression = !dependencies.error && dependencies.status === 0 ? (dependencies.stdout || "").trim() : "";
        const profile = { family: "linux", architecture: "x64", ...runtimeProfile };
        const report = systemDependencies.inspect(binary, profile, { run, detail: check.detail });
        const help = systemDependencies.installationHelp(profile, {
          distribution: "debian", debianDepends: expression, missing: report.missing, abiError: report.abiError,
        });
        throw new Error(`Required OS dependencies for Liquidsoap are missing or incompatible: ${report.missing.join(", ") || check.detail}\n${help}`);
      }
      throw new Error(`The extracted Liquidsoap runtime failed validation: ${check.detail}`);
    }
    activateRuntime(stagingRoot, runtimeRoot);
    const installedBinary = path.join(runtimeRoot, "usr", "bin", "liquidsoap");
    console.log(`Liquidsoap and its standard library installed locally: ${installedBinary}`);
    return installedBinary;
  } finally {
    cleanupRuntimeDirectory(stagingRoot);
  }
}

function verifyPackage(packageInfo) {
  if (!packageInfo) throw new Error("No Liquidsoap package was selected.");
  return download.verifyDownload({
    filePath: packageInfo.filePath,
    sha256: packageInfo.sha256,
    label: packageInfo.fileName,
  });
}

function getDependencyStatus({
  serverRoot = path.resolve(__dirname, ".."),
  runtimeProfile = platform.resolveProfile(),
  inspect = systemDependencies.inspect,
  validate = liquidsoapRuntime.checkRuntime,
} = {}) {
  const liquidsoap = platform.resolveLiquidsoapBinary(serverRoot, runtimeProfile);
  const runtimeCheck = liquidsoap.found
    ? validate(liquidsoap.path)
    : { ok: liquidsoap.found, detail: "not found" };
  const nativeLibraries = liquidsoap.found
    ? inspect(liquidsoap.path, runtimeProfile, { detail: runtimeCheck.detail }) : null;
  if (nativeLibraries?.missing.length && runtimeProfile.family === "linux") {
    nativeLibraries.debianDepends = cachedDebianDepends(serverRoot, runtimeProfile);
  }
  const ffmpegFound = runtimeProfile.family === "windows"
    ? runtimeCheck.ok
    : commandExists("ffmpeg", ["-version"]);
  const items = [
    {
      id: "liquidsoap",
      label: "Liquidsoap",
      found: runtimeCheck.ok,
      detail: runtimeCheck.ok ? liquidsoap.path : runtimeCheck.detail || "not found",
    },
    ...systemDependencies.statusItems("Liquidsoap", nativeLibraries),
    {
      id: "ffmpeg",
      label: "FFmpeg",
      found: ffmpegFound,
      detail: runtimeProfile.family === "windows"
        ? "bundled with Liquidsoap"
        : ffmpegFound
          ? "available on PATH"
          : "not found",
    },
  ];
  const missing = items.filter(({ found }) => !found).map(({ id }) => id);
  return {
    applicable: true,
    detail:
      missing.length === 0
        ? runtimeProfile.family === "windows"
          ? `Liquidsoap is available for ${runtimeProfile.id} (FFmpeg encoder is bundled)`
          : "Liquidsoap and FFmpeg are available"
        : `missing commands: ${missing.join(", ")}`,
    items,
    liquidsoap,
    missing,
    nativeLibraries,
  };
}

function preflightInstall({
  serverRoot = path.resolve(__dirname, ".."),
  runtimeProfile,
  existingBinary,
  debianFamily,
  dependencyStatus,
  osRelease: releaseInfo,
} = {}) {
  const profile = runtimeProfile || platform.resolveProfile();
  const existing = existingBinary || platform.resolveLiquidsoapBinary(serverRoot, profile);
  const status = dependencyStatus || getDependencyStatus({ serverRoot, runtimeProfile: profile });
  const nativeLibraries = status.nativeLibraries;
  const osRelease = releaseInfo || (profile.family === "linux" ? readOsRelease() : {});
  const installedUrl = profile.id
    ? readRuntimeManifest(path.join(serverRoot, "bin", "liquidsoap", profile.id, "runtime.json")).url : undefined;
  const replaceForeignPackage = profile.family === "linux" && existing.source === "platform" &&
    osRelease.distribution && osRelease.codename && typeof installedUrl === "string" &&
    /liquidsoap_.*-(?:ubuntu|debian)-/.test(installedUrl) &&
    !installedUrl.includes(`-${osRelease.distribution}-${osRelease.codename}-`);
  const repairableWindowsPackage = profile.family === "windows" && existing.source === "platform" &&
    nativeLibraries && !nativeLibraries.abiError && !nativeLibraries.missing.some((name) => /^(?:vcruntime|msvcp|concrt)/i.test(name));
  if (!repairableWindowsPackage && !replaceForeignPackage) systemDependencies.assertAvailable("Liquidsoap", profile, nativeLibraries, {
    debianDepends: nativeLibraries?.debianDepends,
    distribution: debianFamily ? "debian" : systemDependencies.linuxDistribution(),
  });
  if (profile.family !== "windows" && status.missing.includes("ffmpeg")) {
    const distribution = debianFamily ? "debian" : systemDependencies.linuxDistribution();
    throw new Error(`Required OS dependency is missing: FFmpeg\n${systemDependencies.installationHelp(profile, { ffmpeg: true, distribution })}`);
  }

  if (
    existing.found &&
    ["PATH", "LIQUIDSOAP_BIN"].includes(existing.source) &&
    profile.family !== "linux"
  ) {
    if (status.missing.includes("liquidsoap")) throw new Error(`Externally managed Liquidsoap failed validation: ${existing.path}. Repair it before installing runtimes.`);
    return;
  }

  if (profile.family === "windows") {
    const canUseX64 = process.arch === "x64" && profile.architecture === "x86";
    if (profile.architecture !== "x64" && !canUseX64) {
      throw new Error(
        `No official Liquidsoap binary package is available for ${profile.id}. ` +
          "Install Liquidsoap with OPAM and set LIQUIDSOAP_BIN.",
      );
    }
    return;
  }

  if (profile.family === "linux") {
    const isDebian = debianFamily ?? isDebianFamily();
    if (!isDebian) {
      if (existing.found && !status.missing.includes("liquidsoap")) return;
      throw new Error(
        "No verified direct package matches this Linux distribution. " +
          "Install Liquidsoap with the system package manager or OPAM, then set LIQUIDSOAP_BIN.",
      );
    }

    return;
  }

  if (existing.found) {
    if (status.missing.includes("liquidsoap")) throw new Error(`Supplied Liquidsoap failed validation: ${existing.path}. Repair it before installing runtimes.`);
    return;
  }
  throw new Error(
    `No official prebuilt Liquidsoap package is published for ${profile.id}. ` +
      "Install it with OPAM (`opam install ffmpeg liquidsoap`) and set LIQUIDSOAP_BIN.",
  );
}

async function installWindowsLiquidsoap(serverRoot, runtimeProfile, { force = false } = {}) {
  const canUseX64 = process.arch === "x64" && runtimeProfile.family === "windows";
  if (runtimeProfile.architecture !== "x64" && !canUseX64) {
    throw new Error(
      `No official Liquidsoap binary package is available for ${runtimeProfile.id}. ` +
        "Install Liquidsoap with OPAM and set LIQUIDSOAP_BIN.",
    );
  }

  const packageInfo = await releases.latestPackage(
    { family: "windows", architecture: "x64" }, serverRoot, [WINDOWS_LIQUIDSOAP_PACKAGE],
  );
  const installProfile = "windows-x64";
  const runtimeRoot = path.join(serverRoot, "bin", "liquidsoap", installProfile);
  const executablePath = path.join(runtimeRoot, "liquidsoap.exe");
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  const installed = readRuntimeManifest(manifestPath);
  if (fs.existsSync(executablePath) && installed.sha256 === packageInfo.sha256 &&
      liquidsoapRuntime.checkRuntime(executablePath).ok && !force) {
    console.log(`Liquidsoap is already installed: ${executablePath}`);
    return executablePath;
  }

  console.log(`Downloading ${packageInfo.fileName} from the official Liquidsoap release...`);
  await download.downloadVerified({ ...packageInfo, force, label: packageInfo.fileName });
  fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true, mode: 0o750 });
  const stagingRoot = fs.mkdtempSync(path.join(path.dirname(runtimeRoot), "windows-x64.tmp-"));
  try {
    const result = spawnSync("tar.exe", ["-xf", packageInfo.filePath, "-C", stagingRoot], { stdio: "inherit" });
    const extractedRoot = path.join(stagingRoot, packageInfo.directoryName);
    const check = result.status === 0 && liquidsoapRuntime.checkRuntime(path.join(extractedRoot, "liquidsoap.exe"));
    if (!check || !check.ok) {
      if (check) systemDependencies.assertAvailable("Liquidsoap", { ...runtimeProfile, architecture: "x64" },
        systemDependencies.inspect(path.join(extractedRoot, "liquidsoap.exe"), { ...runtimeProfile, architecture: "x64" }, { detail: check.detail }));
      throw new Error(`Liquidsoap extraction or validation failed: ${result.error?.message || check?.detail || result.status}.`);
    }
    fs.writeFileSync(path.join(extractedRoot, "runtime.json"), `${JSON.stringify({ version: packageInfo.version, sha256: packageInfo.sha256, url: packageInfo.url }, null, 2)}\n`);
    activateRuntime(extractedRoot, runtimeRoot);
  } finally {
    cleanupRuntimeDirectory(stagingRoot);
  }
  console.log(`Liquidsoap installed for ${installProfile}: ${executablePath}`);
  return executablePath;
}

async function installLinuxDependencies(serverRoot, runtimeProfile, { force = false } = {}) {
  if (!isDebianFamily()) {
    const existing = platform.resolveLiquidsoapBinary(serverRoot, runtimeProfile);
    if (existing.found) {
      console.log(`Liquidsoap is managed outside this repository: ${existing.path}`);
      return existing.path;
    }
    throw new Error(
      "No verified direct package matches this Linux distribution. Install Liquidsoap with the system package manager or OPAM, then set LIQUIDSOAP_BIN.",
    );
  }

  const osRelease = readOsRelease();
  const { missing } = getDependencyStatus({ serverRoot, runtimeProfile });
  const existing = platform.resolveLiquidsoapBinary(serverRoot, runtimeProfile);
  const systemPackageInstalled =
    existing.found && existing.source === "PATH" && debianPackageIsInstalled("liquidsoap") && debianPackageOwnsBinary(existing.path);
  const plan = getLinuxInstallPlan({
    existing,
    systemPackageInstalled,
  });
  if (plan.externallyManagedLiquidsoap) {
    if (missing.includes("liquidsoap")) {
      throw new Error(`Externally managed Liquidsoap is incomplete: ${existing.path}. Repair it or remove LIQUIDSOAP_BIN to use the local runtime.`);
    }
    console.log(`Liquidsoap is externally managed and was not modified: ${existing.path}`);
    return existing.path;
  }
  const packageInfo = await releases.latestPackage(
    { ...osRelease, ...runtimeProfile }, serverRoot, LIQUIDSOAP_PACKAGES,
  );
  console.log(`Latest compatible stable Liquidsoap: ${packageInfo.version} (${osRelease.distribution}/${osRelease.codename}).`);
  const runtimeRoot = path.join(serverRoot, "bin", "liquidsoap", runtimeProfile.id);
  const installed = readRuntimeManifest(path.join(runtimeRoot, "runtime.json"));
  if (!force && installed.sha256 === packageInfo.sha256 && !missing.includes("liquidsoap")) {
    console.log(`Liquidsoap is already up to date: ${existing.path}`);
    return existing.path;
  }
  console.log(`Downloading ${packageInfo.fileName} from the official Liquidsoap release...`);
  await download.downloadVerified({ ...packageInfo, force, label: packageInfo.fileName });
  return extractLinuxPackage(packageInfo, serverRoot, runtimeProfile);
}

function cachedDebianDepends(serverRoot, profile) {
  try {
    const manifest = readRuntimeManifest(path.join(serverRoot, "bin", "liquidsoap", profile.id, "runtime.json"));
    const fileName = path.basename(new URL(manifest.url).pathname);
    if (!fileName.endsWith(".deb")) return "";
    const filePath = path.join(serverRoot, "bin", "downloads", "liquidsoap", fileName);
    download.verifyDownload({ filePath, sha256: manifest.sha256, label: fileName });
    const result = spawnSync("dpkg-deb", ["--field", filePath, "Depends"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    return !result.error && result.status === 0 ? result.stdout.trim() : "";
  } catch { return ""; }
}

async function installDependencies({ force = false, serverRoot = path.resolve(__dirname, "..") } = {}) {
  const runtimeProfile = platform.resolveProfile();
  const existing = platform.resolveLiquidsoapBinary(serverRoot, runtimeProfile);
  if (
    existing.found &&
    ["PATH", "LIQUIDSOAP_BIN"].includes(existing.source) &&
    runtimeProfile.family !== "linux"
  ) {
    console.log(
      `Liquidsoap is managed outside this repository${force ? " and was not modified" : ""}: ${existing.path}`,
    );
    return existing.path;
  }
  if (runtimeProfile.family === "windows") {
    return installWindowsLiquidsoap(serverRoot, runtimeProfile, { force });
  }
  if (runtimeProfile.family === "linux") {
    return installLinuxDependencies(serverRoot, runtimeProfile, { force });
  }
  if (existing.found) {
    console.log(`Liquidsoap is managed outside this repository: ${existing.path}`);
    return existing.path;
  }
  throw new Error(
    `No official prebuilt Liquidsoap package is published for ${runtimeProfile.id}. ` +
      "Install it with OPAM (`opam install ffmpeg liquidsoap`) and set LIQUIDSOAP_BIN.",
  );
}

module.exports = {
  LIQUIDSOAP_PACKAGES,
  WINDOWS_LIQUIDSOAP_PACKAGE,
  activateRuntime,
  extractLinuxPackage,
  debianPackageIsInstalled,
  debianPackageOwnsBinary,
  getDependencyStatus,
  getLinuxInstallPlan,
  installDependencies,
  installWindowsLiquidsoap,
  parseOsRelease,
  preflightInstall,
  verifyPackage,
};
