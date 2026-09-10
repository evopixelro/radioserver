const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function getResources(binary) {
  if (!path.isAbsolute(binary)) return null;
  const executableDirectory = path.dirname(binary);
  if (path.basename(executableDirectory) !== "bin" ||
      path.basename(path.dirname(executableDirectory)) !== "usr") return null;
  const root = path.resolve(executableDirectory, "..", "..");
  if (!fs.existsSync(path.join(root, "runtime.json"))) return null;
  return path.join(root, "usr", "share", "liquidsoap");
}

function getArguments(binary, args = []) {
  const resources = getResources(binary);
  if (!resources) return args;
  const stdlib = path.join(resources, "libs", "stdlib.liq");
  if (!fs.existsSync(stdlib)) {
    throw new Error("Local Liquidsoap standard library is missing. Run npm run install to repair bin/liquidsoap.");
  }
  const bootstrap = ["--no-stdlib", stdlib];
  const deprecated = path.join(resources, "libs", "extra", "deprecations.liq");
  if (fs.existsSync(deprecated)) bootstrap.push(deprecated);
  // Load the matching library explicitly because Linux packages use absolute system paths
  bootstrap.push(`settings.charset.path := ${JSON.stringify(path.join(resources, "camomile").replaceAll("\\", "/"))}`);
  return [...bootstrap, ...args];
}

function checkRuntime(binary, run = spawnSync) {
  try {
    const result = run(binary, getArguments(binary, ["--check", "()"]), {
      encoding: "utf8", timeout: 45000, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: !result.error && result.status === 0,
      detail: result.error?.message || `${result.stderr || ""}\n${result.stdout || ""}`.trim() ||
        (result.status === 0 ? "" : `Process exited with status ${result.status}${result.signal ? ` (${result.signal})` : ""}`),
    };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

module.exports = { checkRuntime, getArguments, getResources };
