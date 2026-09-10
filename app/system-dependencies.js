const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROBE_OPTIONS = {
  encoding: "utf8", timeout: 15000, windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LC_ALL: "C" },
};

function linuxDistribution() {
  try {
    return fs.readFileSync("/etc/os-release", "utf8").match(/^ID=["']?([a-z0-9_-]+)/m)?.[1] || "";
  } catch { return ""; }
}

function missingFromError(detail) {
  const names = [];
  for (const line of String(detail || "").split(/\r?\n/)) {
    const match = line.match(/loading shared libraries:\s*([^:\s]+)/i) ||
      line.match(/Library not loaded:\s*(\S+)/i) ||
      line.match(/Shared object ["']([^"']+)["'] not found/i) ||
      line.match(/\b([\w.+-]+\.dll)\b.*(?:not found|missing|could not be found)/i);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)];
}

function parseLdd(output) {
  const libraries = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+=>\s+(.+?)\s*$/);
    if (!match) continue;
    libraries.push({ name: match[1], found: !/^not found\b/.test(match[2]) });
  }
  return libraries;
}

function macosSlice(output, architecture) {
  const text = String(output || "");
  const headers = [...text.matchAll(/^.+ \(architecture ([^)]+)\):\s*$/gm)];
  if (!headers.length) return { text, architecture };
  const names = { x64: "x86_64", x86: "i386", arm64: "arm64" };
  let selected = headers.find((header) => header[1] === names[architecture]);
  // An Intel-only executable can run on Apple Silicon only with OS translation
  if (!selected && architecture === "arm64") selected = headers.find((header) => header[1] === "x86_64");
  if (!selected) return { text: "", architecture };
  const next = headers[headers.indexOf(selected) + 1];
  return { text: text.slice(selected.index, next?.index), architecture: Object.keys(names).find((key) => names[key] === selected[1]) };
}

function elfArchitecture(data) {
  if (data.length < 52 || data.toString("hex", 0, 4) !== "7f454c46") return null;
  if (data[5] !== 1 || data[6] !== 1 || data.readUInt32LE(20) !== 1) return null;
  if (![2, 3].includes(data.readUInt16LE(16))) return null;

  const machines = {
    3: { name: "x86", elfClass: 1 },
    40: { name: "arm", elfClass: 1 },
    62: { name: "x64", elfClass: 2 },
    183: { name: "arm64", elfClass: 2 },
  };
  const machine = machines[data.readUInt16LE(18)];
  if (!machine || data[4] !== machine.elfClass || data.length < (machine.elfClass === 1 ? 52 : 64)) return null;
  return machine.name;
}

// Read direct PE imports without starting the executable
function windowsImports(data) {
  try {
    if (data.toString("ascii", 0, 2) !== "MZ") return null;
    const header = data.readUInt32LE(0x3c);
    if (data.readUInt32LE(header) !== 0x4550) return null;
    const machine = data.readUInt16LE(header + 4);
    const optional = header + 24;
    const magic = data.readUInt16LE(optional);
    if (![0x14c, 0x8664, 0xaa64].includes(machine) || ![0x10b, 0x20b].includes(magic) ||
        (machine === 0x14c) !== (magic === 0x10b)) return null;
    const directory = optional + (magic === 0x20b ? 112 : 96);
    const table = optional + data.readUInt16LE(header + 20);
    const sections = [];
    for (let index = 0; index < data.readUInt16LE(header + 6); index += 1) {
      const offset = table + index * 40;
      sections.push({
        address: data.readUInt32LE(offset + 12), size: data.readUInt32LE(offset + 16),
        offset: data.readUInt32LE(offset + 20),
      });
    }
    const fileOffset = (rva) => {
      const section = sections.find((item) => rva >= item.address && rva < item.address + item.size);
      if (!section) throw new Error("Invalid PE address");
      return section.offset + rva - section.address;
    };
    const rva = data.readUInt32LE(directory + 8);
    if (!rva) return { architecture: machine === 0x14c ? "x86" : machine === 0xaa64 ? "arm64" : "x64", names: [] };
    const size = Math.min(data.readUInt32LE(directory + 12), 20 * 4096);
    const imports = fileOffset(rva);
    const names = [];
    for (let index = 0; index + 20 <= size; index += 20) {
      const nameRva = data.readUInt32LE(imports + index + 12);
      if (!nameRva) break;
      const start = fileOffset(nameRva);
      const end = data.indexOf(0, start);
      if (end < start || end - start > 255) return null;
      const name = data.toString("ascii", start, end);
      if (!/^[\w.+-]+\.dll$/i.test(name)) return null;
      names.push(name);
    }
    return { architecture: machine === 0x14c ? "x86" : machine === 0xaa64 ? "arm64" : "x64", names };
  } catch { return null; }
}

function inspect(binary, profile, {
  run = spawnSync, exists = fs.existsSync, readFile = fs.readFileSync,
  realpath = fs.realpathSync, environment = process.env, detail = "",
} = {}) {
  let libraries = [];
  let checked = false;
  let architecture = profile.architecture;
  let diagnostic = "";
  if (["linux", "freebsd"].includes(profile.family)) {
    const result = run("ldd", [binary], PROBE_OPTIONS);
    diagnostic = `${result.error?.message || ""}\n${result.stderr || ""}\n${result.stdout || ""}`.trim();
    libraries = parseLdd(diagnostic);
    checked = !result.error && (result.status === 0 || libraries.length > 0);
    if (!result.error && !libraries.length && /statically linked|not a dynamic executable/.test(diagnostic)) {
      // ldd can report plain text or a foreign executable as non-dynamic
      checked = false;
      try {
        const detected = elfArchitecture(readFile(binary));
        checked = detected !== null;
        if (checked) architecture = detected;
      } catch {}
    }
  } else if (profile.family === "macos") {
    const result = run("otool", ["-L", binary], PROBE_OPTIONS);
    diagnostic = `${result.error?.message || ""}\n${result.stderr || ""}\n${result.stdout || ""}`.trim();
    const selected = macosSlice(result.stdout, architecture);
    architecture = selected.architecture;
    checked = !result.error && result.status === 0 && /^\S.*:\s*$/m.test(selected.text);
    let executable = binary;
    try { executable = realpath(binary); } catch {}
    const expand = (name) => path.posix.normalize(name.replace(/^@(?:loader_path|executable_path)(?=\/|$)/, () => path.posix.dirname(executable)));
    const systemLibrary = (name) => name.startsWith("/usr/lib/") || name.startsWith("/System/Library/");
    let rpaths = [];
    if (/@rpath\//.test(selected.text)) {
      const loadCommands = run("otool", ["-l", binary], PROBE_OPTIONS);
      diagnostic += `\n${loadCommands.error?.message || ""}\n${loadCommands.stderr || ""}`;
      if (loadCommands.error || loadCommands.status !== 0) checked = false;
      else {
        const commands = macosSlice(loadCommands.stdout, architecture).text;
        if (!/^\S.*:\s*$/m.test(commands)) checked = false;
        rpaths = [...commands.matchAll(/\bcmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)]
          .map((match) => expand(match[1]));
      }
    }
    for (const line of selected.text.split(/\r?\n/).slice(1)) {
      const name = line.match(/^\s+(.+?)\s+\(compatibility version/)?.[1];
      if (!name) continue;
      // Apple system libraries can exist only in the dyld shared cache
      const candidates = name.startsWith("@rpath/")
        ? rpaths.map((directory) => path.posix.join(directory, name.slice(7))) : [expand(name)];
      libraries.push({ name, found: candidates.some((candidate) => !candidate.startsWith("@") && (systemLibrary(candidate) || exists(candidate))) });
    }
  } else if (profile.family === "windows") {
    let imports;
    try { imports = windowsImports(readFile(binary)); } catch {}
    checked = Boolean(imports);
    if (imports) {
      architecture = imports.architecture;
      const root = environment.SystemRoot || environment.WINDIR;
      const systemDirectory = architecture === "x86" &&
        (environment.PROCESSOR_ARCHITEW6432 || /AMD64|ARM64/i.test(environment.PROCESSOR_ARCHITECTURE || ""))
        ? "SysWOW64" : "System32";
      const directories = [path.dirname(binary), ...(root ? [path.join(root, systemDirectory)] : []),
        ...(environment.PATH || environment.Path || "").split(";").filter(Boolean)];
      libraries = imports.names.filter((name) => !/^(api|ext)-ms-/i.test(name)).map((name) => ({
        name, found: directories.some((directory) => exists(path.join(directory, name))),
      }));
    }
  }
  for (const name of missingFromError(`${diagnostic}\n${detail}`)) {
    const existing = libraries.find((item) => item.name === name);
    if (existing) existing.found = false;
    else libraries.push({ name, found: false });
  }
  const abiError = /version [`'][^\r\n]+not found|wrong ELF class|incompatible architecture|Bad CPU type|0xc000007b/i.test(`${detail}\n${diagnostic}`);
  const inspectionTool = profile.family === "macos" ? "otool (Xcode Command Line Tools)"
    : profile.family === "windows" ? "the PE import reader" : "ldd";
  const inspectionError = !checked
    ? `Could not inspect native dependencies with ${inspectionTool}. Ensure the executable matches this OS and architecture${profile.family !== "windows" ? " and the inspection tool is available" : ""}${diagnostic ? `: ${diagnostic}` : ""}` : "";
  return { checked, architecture, libraries, missing: libraries.filter((item) => !item.found).map((item) => item.name), abiError, inspectionError };
}

function statusItems(label, report) {
  if (!report) return [];
  const items = report.missing.map((name) => ({
    id: `native:${label}:${name}`, label: `${label} library (${name})`, found: false,
    detail: "required by the executable, not available to the OS loader",
  }));
  if (report.abiError) items.push({ id: `abi:${label}`, label: `${label} OS compatibility`, found: false, detail: "incompatible library version or architecture" });
  if (report.inspectionError) items.push({ id: `inspection:${label}`, label: `${label} native inspection`, found: false, detail: report.inspectionError });
  if (!items.length && report.checked) items.push({
    id: `native:${label}`, label: `${label} native libraries`, found: true,
    detail: `${report.libraries.length} direct/resolved dependencies checked`,
  });
  return items;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function installationHelp(profile, {
  missing = [], ffmpeg = false, distribution = linuxDistribution(), debianDepends = "", abiError = false,
  color = Boolean(process.stderr.isTTY) && !("NO_COLOR" in process.env),
} = {}) {
  const commands = [];
  const notes = [];
  const names = missing.map((name) => name.split(/[\\/]/).at(-1));
  let privilege = "Run as root";
  const taglib = names.some((name) => /^libtag(?:\.so\.|\.)/.test(name));
  if (abiError) notes.push("Use a binary built for this OS release and architecture; do not symlink incompatible library versions");
  if (profile.family === "linux" && ["ubuntu", "debian"].includes(distribution)) {
    if (debianDepends && !/[\r\n']/.test(debianDepends) && !/^\s*Conflicts:/i.test(debianDepends)) {
      commands.push(`sudo apt-get --no-remove satisfy ${quote(debianDepends)}${ffmpeg ? " 'ffmpeg'" : ""}`);
    } else {
      const packages = [];
      if (ffmpeg) packages.push("ffmpeg");
      if (names.includes("libtag.so.1")) packages.push("libtag1v5");
      if (packages.length) commands.push(`sudo apt-get install ${packages.join(" ")}`);
      const unknown = names.filter((name) => name !== "libtag.so.1");
      if (unknown.length) notes.push(`No verified package mapping for: ${unknown.join(", ")}. Use the matching vendor package's Depends field, not a package from another OS release`);
    }
  } else if (profile.family === "linux" && ["fedora", "rhel", "rocky", "almalinux", "centos"].includes(distribution)) {
    const capabilities = names.filter((name) => /^[\w.+-]+\.so(?:\.[\d.]+)?$/.test(name))
      .map((name) => quote(`${name}()${profile.architecture === "x64" || profile.architecture === "arm64" ? "(64bit)" : ""}`));
    if (ffmpeg) capabilities.unshift("ffmpeg");
    if (capabilities.length) commands.push(`sudo dnf install ${capabilities.join(" ")}`);
    notes.push("Packages must be available in the configured repositories; no third-party repositories are enabled automatically");
  } else if (["macos", "freebsd"].includes(profile.family) || (profile.family === "linux" && distribution === "arch")) {
    const packages = [...(ffmpeg ? ["ffmpeg"] : []), ...(taglib ? ["taglib"] : [])];
    if (profile.family === "macos") {
      privilege = "Run as your normal user (Homebrew must not run as root)";
      if (packages.length) commands.push(`brew install ${packages.join(" ")}`);
      notes.push("Homebrew is required: https://brew.sh");
    } else if (profile.family === "freebsd") {
      if (packages.length) commands.push(`pkg install ${packages.join(" ")}`);
    } else if (packages.length) commands.push(`sudo pacman -S --needed ${packages.join(" ")}`);
    if (missing.length) notes.push("If the required library version is still unavailable, rebuild or obtain a matching binary; installing a newer ABI cannot repair an older executable");
  } else if (profile.family === "windows") {
    privilege = "Run in an Administrator terminal (approve the Windows UAC prompt)";
    if (names.some((name) => /^(?:vcruntime140(?:_1)?|msvcp140(?:_\w+)?|concrt140)\.dll$/i.test(name))) {
      commands.push(`winget install --exact --id Microsoft.VCRedist.2015+.${profile.architecture}`);
      notes.push("If winget is unavailable: https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist");
    }
    if (names.some((name) => !/^(?:vcruntime140(?:_1)?|msvcp140(?:_\w+)?|concrt140)\.dll$/i.test(name))) {
      notes.push("Other DLLs must come from the complete official runtime package or its vendor prerequisites, never a DLL download site. Repair managed packages with npm run update as your normal user");
    }
    if (ffmpeg) notes.push("FFmpeg is bundled with the official Windows Liquidsoap package; repair that package with npm run update, without Administrator rights");
  }
  if (!commands.length && !notes.length) notes.push("No verified install command is available for these dependencies on this OS; use the matching runtime vendor's prerequisites");
  const renderedCommands = commands.map((command) => color ? `\u001b[33m${command}\u001b[0m` : command);
  return [...(commands.length ? [`${privilege}:`, ...renderedCommands] : []), ...notes,
    "Only OS dependencies need system privileges. Rerun npm run install or npm run update as your normal user"].join("\n");
}

function assertAvailable(label, profile, report, options = {}) {
  if (report?.inspectionError) {
    const error = new Error(`${label}: ${report.inspectionError}`);
    error.code = "RADIO_NATIVE_INSPECTION";
    throw error;
  }
  if (!report || (!report.missing.length && !report.abiError)) return;
  const error = new Error(`Required OS dependencies for ${label} are missing or incompatible: ${report.missing.join(", ") || "library ABI"}\n` +
    installationHelp({ ...profile, architecture: report.architecture || profile.architecture }, { ...options, missing: report.missing, abiError: report.abiError }));
  error.code = "RADIO_OS_DEPENDENCIES";
  throw error;
}

module.exports = { assertAvailable, inspect, installationHelp, linuxDistribution, missingFromError, parseLdd, statusItems, windowsImports };
