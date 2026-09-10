const fs = require("node:fs");
const path = require("node:path");

const PLATFORM_ALIASES = new Map([
  ["linux", "linux"],
  ["win32", "windows"],
  ["windows", "windows"],
  ["darwin", "macos"],
  ["mac", "macos"],
  ["macos", "macos"],
  ["freebsd", "freebsd"],
]);

const ARCHITECTURE_ALIASES = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["ia32", "x86"],
  ["x86", "x86"],
  ["i386", "x86"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
  ["arm", "arm"],
]);

function normalizeFamily(value) {
  return PLATFORM_ALIASES.get(String(value || "").trim().toLowerCase()) || null;
}

function normalizeArchitecture(value) {
  return ARCHITECTURE_ALIASES.get(String(value || "").trim().toLowerCase()) || null;
}

function detectProfile({ platform = process.platform, architecture = process.arch } = {}) {
  const family = normalizeFamily(platform);
  const normalizedArchitecture = normalizeArchitecture(architecture);
  if (!family) {
    throw new Error(`Unsupported operating system: ${platform}`);
  }
  if (!normalizedArchitecture) {
    throw new Error(`Unsupported processor architecture: ${architecture}`);
  }
  return {
    family,
    architecture: normalizedArchitecture,
    id: `${family}-${normalizedArchitecture}`,
  };
}

function parseSelection(selection, hostProfile) {
  const normalized = String(selection || "auto").trim().toLowerCase();
  if (!normalized || normalized === "auto") return hostProfile;

  const exactMatch = normalized.match(/^([a-z0-9]+)-(x64|amd64|x86|ia32|i386|arm64|aarch64|arm)$/);
  const family = normalizeFamily(exactMatch ? exactMatch[1] : normalized);
  const architecture = exactMatch
    ? normalizeArchitecture(exactMatch[2])
    : hostProfile.architecture;
  if (!family || !architecture) {
    throw new Error(
      `Invalid RADIO_PLATFORM value: ${selection}. ` +
        "Use auto, linux, windows, macos, freebsd or an OS-architecture pair such as windows-x64.",
    );
  }

  return { family, architecture, id: `${family}-${architecture}` };
}

function resolveProfile(
  selection = process.env.RADIO_PLATFORM,
  host = { platform: process.platform, architecture: process.arch },
) {
  const hostProfile = detectProfile(host);
  const profile = parseSelection(selection, hostProfile);
  const windowsX86OnX64 =
    profile.family === "windows" &&
    hostProfile.family === "windows" &&
    profile.architecture === "x86" &&
    hostProfile.architecture === "x64";
  if (profile.id !== hostProfile.id && !windowsX86OnX64) {
    throw new Error(
      `Runtime profile ${profile.id} cannot run on this ${hostProfile.id} host. ` +
        "Run the matching npm command on its target operating system.",
    );
  }
  return profile;
}

function executableExists(filePath, family = detectProfile().family) {
  try {
    fs.accessSync(filePath, family === "windows" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command, profile, environment = process.env) {
  const pathValue = environment.PATH || environment.Path || "";
  const extensions = profile.family === "windows"
    ? (environment.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const hasExtension = path.extname(command) !== "";

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (executableExists(candidate, profile.family)) return path.resolve(candidate);
      if (profile.family === "windows") {
        const originalCaseCandidate = path.join(directory, `${command}${extension}`);
        if (executableExists(originalCaseCandidate, profile.family)) {
          return path.resolve(originalCaseCandidate);
        }
      }
    }
  }
  return null;
}

function resolveOverride(value, profile, environment) {
  if (!value) return null;
  if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    return path.resolve(value);
  }
  return findOnPath(value, profile, environment) || value;
}

function firstAvailable(candidates) {
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

function resolveShoutcastBinary(serverRoot, profile, environment = process.env) {
  const override = resolveOverride(environment.SC_SERV_BIN, profile, environment);
  if (override) {
    return { path: override, found: executableExists(override, profile.family), source: "SC_SERV_BIN" };
  }

  const runtimeRoot = path.join(serverRoot, "bin", "shoutcast");
  const candidates = [];
  if (profile.family === "linux") {
    candidates.push(path.join(runtimeRoot, profile.id, "sc_serv"));
  }
  if (profile.family === "windows") {
    candidates.push(
      path.join(runtimeRoot, profile.id, "sc_serv.exe"),
      path.join(serverRoot, "sc_serv.exe"),
    );
    for (const base of [environment.ProgramFiles, environment["ProgramFiles(x86)"], environment.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(
        path.join(base, "SHOUTcast", "sc_serv.exe"),
        path.join(base, "SHOUTcast DNAS", "sc_serv.exe"),
      );
    }
  }
  if (["macos", "freebsd"].includes(profile.family)) {
    candidates.push(path.join(runtimeRoot, profile.id, "sc_serv"));
  }

  const bundledOrInstalled = firstAvailable(candidates);
  const fromPath = findOnPath(profile.family === "windows" ? "sc_serv.exe" : "sc_serv", profile, environment);
  const resolved = bundledOrInstalled || fromPath;
  return {
    path: resolved || candidates[0] || (profile.family === "windows" ? "sc_serv.exe" : "sc_serv"),
    found: Boolean(resolved),
    source: bundledOrInstalled
      ? path.dirname(bundledOrInstalled) === path.join(runtimeRoot, profile.id) ? "platform" : "external"
      : fromPath ? "PATH" : "missing",
    candidates,
  };
}

function resolveLiquidsoapBinary(serverRoot, profile, environment = process.env) {
  const override = resolveOverride(environment.LIQUIDSOAP_BIN, profile, environment);
  if (override) {
    return { path: override, found: executableExists(override, profile.family), source: "LIQUIDSOAP_BIN" };
  }

  const executableName = profile.family === "windows" ? "liquidsoap.exe" : "liquidsoap";
  const runtimeRoot = path.join(serverRoot, "bin", "liquidsoap");
  const candidates = [path.join(runtimeRoot, profile.id, executableName)];
  if (profile.family === "linux") {
    candidates.unshift(path.join(runtimeRoot, profile.id, "usr", "bin", executableName));
  }
  if (profile.family === "windows" && (profile.architecture === "x64" || process.arch === "x64")) {
    candidates.unshift(
      path.join(
        runtimeRoot,
        "windows-x64",
        "liquidsoap.exe",
      ),
    );
  }

  const local = firstAvailable(candidates);
  const fromPath = findOnPath(executableName, profile, environment);
  return {
    path: local || fromPath || candidates[0] || executableName,
    found: Boolean(local || fromPath),
    source: local ? "platform" : fromPath ? "PATH" : "missing",
    candidates,
  };
}

module.exports = {
  detectProfile,
  executableExists,
  findOnPath,
  normalizeArchitecture,
  normalizeFamily,
  resolveLiquidsoapBinary,
  resolveProfile,
  resolveShoutcastBinary,
};
