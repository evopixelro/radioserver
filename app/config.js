const path = require("node:path");
const platform = require("./platform");

const serverRoot = path.resolve(__dirname, "..");
const runDirectory = path.resolve(serverRoot, process.env.RADIO_RUN_DIR || ".run");
const logDirectory = path.resolve(serverRoot, process.env.RADIO_LOG_DIR || "logs");
const runtimeProfile = platform.resolveProfile();
const binary = platform.resolveShoutcastBinary(serverRoot, runtimeProfile);

function logSetting(name, fallback, maximum) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function readArguments() {
  const raw = process.env.SC_SERV_ARGS_JSON;
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`SC_SERV_ARGS_JSON is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("SC_SERV_ARGS_JSON must be a JSON array of strings without null characters");
  }

  return parsed;
}

module.exports = {
  serverRoot,
  runDirectory,
  logDirectory,
  runtimeProfile,
  binaryPath: binary.path,
  binarySource: binary.source,
  configPath: path.resolve(serverRoot, process.env.SC_SERV_CONFIG || "sc_serv.conf"),
  pidPath: path.join(runDirectory, "sc_serv.pid"),
  stdoutLogPath: path.join(logDirectory, "sc_serv.stdout.log"),
  stderrLogPath: path.join(logDirectory, "sc_serv.error.log"),
  // Validate SHOUTcast-only settings when launching SHOUTcast, not other commands
  readRunOptions() {
    return {
      logOptions: { maxBytes: logSetting("SC_LOG_MAX_SIZE_MB", 10, 1024) * 1024 * 1024, maxFiles: logSetting("SC_LOG_MAX_FILES", 5, 100) },
      arguments: readArguments(),
    };
  },
};
