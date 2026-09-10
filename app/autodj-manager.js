const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const liquidsoapConfig = require("./liquidsoap-config");
const liquidsoapRuntime = require("./liquidsoap-runtime");
const metadataRepair = require("./metadata-repair");
const platform = require("./platform");
const { generatePlaylist, writePlaylists } = require("./playlist-generator");
const logRotation = require("./log-rotation");
const processState = require("./process-state");
const { assertLogSeparation } = require("./log-cleanup");
const { beginChildStartup } = require("./control-lock");

const MINIMUM_LIQUIDSOAP_VERSION = [2, 2, 5];

function parseVersion(value) {
  const match = String(value).match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1, 4).map((part) => Number(part || 0)) : null;
}

function versionIsSupported(version) {
  for (let index = 0; index < MINIMUM_LIQUIDSOAP_VERSION.length; index += 1) {
    if (version[index] > MINIMUM_LIQUIDSOAP_VERSION[index]) return true;
    if (version[index] < MINIMUM_LIQUIDSOAP_VERSION[index]) return false;
  }
  return true;
}

function getConfig(serverRoot) {
  const autodjRoot = path.resolve(serverRoot, process.env.AUTODJ_ROOT || ".");
  const runDirectory = path.resolve(serverRoot, process.env.RADIO_RUN_DIR || ".run");
  const logDirectory = path.resolve(serverRoot, process.env.RADIO_LOG_DIR || "logs");
  const runtimeProfile = platform.resolveProfile();
  const binary = platform.resolveLiquidsoapBinary(serverRoot, runtimeProfile);
  return {
    serverRoot,
    autodjRoot,
    runDirectory,
    logDirectory,
    runtimeProfile,
    binaryPath: binary.path,
    binarySource: binary.source,
    configPath: path.join(serverRoot, "autodj.config.json"),
    scriptPath: path.join(runDirectory, "autodj.liq"),
    pidPath: path.join(runDirectory, "autodj.pid"),
    logPath: path.join(logDirectory, "autodj.log"),
  };
}

function binaryIsAPath(binary) {
  return path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\");
}

function findBinary(config) {
  const binary = binaryIsAPath(config.binaryPath)
    ? path.resolve(config.binaryPath)
    : config.binaryPath;

  if (binaryIsAPath(binary)) {
    try {
      fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      throw new Error(`Liquidsoap executable was not found or is not executable: ${binary}`);
    }
  }

  const result = childProcess.spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Liquidsoap could not be started for ${config.runtimeProfile.id} (${binary}): ${result.error.message}. ` +
        "Run npm run install on the target host or set LIQUIDSOAP_BIN.",
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `Liquidsoap version check failed with status ${result.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  const reportedVersion = `${result.stdout || ""}\n${result.stderr || ""}`;
  const version = parseVersion(reportedVersion);
  if (!version) {
    throw new Error(`Could not determine the Liquidsoap version reported by ${binary}.`);
  }
  if (!versionIsSupported(version)) {
    throw new Error(
      `Liquidsoap ${version.join(".")} is too old; version ${MINIMUM_LIQUIDSOAP_VERSION.join(".")} or newer is required.`,
    );
  }
  return binary;
}

function ensureDirectories(config) {
  fs.mkdirSync(config.runDirectory, { recursive: true, mode: 0o750 });
  fs.mkdirSync(config.logDirectory, { recursive: true, mode: 0o750 });
}

function checkScript(binary, scriptPath, password) {
  const result = childProcess.spawnSync(binary, liquidsoapRuntime.getArguments(binary, ["--check", scriptPath]), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Liquidsoap configuration check could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    let detail = (result.stderr || result.stdout || "").trim();
    if (password) {
      for (const value of [JSON.stringify(password).slice(1, -1), password]) {
        detail = detail.replaceAll(value, "[REDACTED]");
      }
    }
    throw new Error(
      `Liquidsoap rejected the generated configuration${detail ? `:\n${detail}` : "."}`,
    );
  }
}

function loadConfiguration(config) {
  return liquidsoapConfig.loadConfig({
    autodjRoot: config.serverRoot,
    configPath: config.configPath,
  });
}

function prepareRuntime(config, { validationOnly = false } = {}) {
  assertLogSeparation({
    serverRoot: config.serverRoot,
    configPath: path.resolve(config.serverRoot, process.env.SC_SERV_CONFIG || "sc_serv.conf"),
    stdoutLogPath: path.join(config.logDirectory, "sc_serv.stdout.log"),
    stderrLogPath: path.join(config.logDirectory, "sc_serv.error.log"),
  }, config.logPath);
  if (!validationOnly) ensureDirectories(config);
  const binary = findBinary(config);
  const runtimeConfig = loadConfiguration(config);
  const playlist = generatePlaylist({ serverRoot: config.serverRoot, dryRun: true });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "radio-preflight-"));
  try {
    const preparedConfig = {
      ...runtimeConfig,
      playlistSources: playlist.playlists.map((item) => ({
        id: item.id,
        playlistPath: path.join(temporary, `${item.id}.lst`),
        weight: item.weight,
      })),
    };
    playlist.playlists.forEach((item, index) => fs.writeFileSync(preparedConfig.playlistSources[index].playlistPath,
      `${item.entries.join("\n")}\n`, { mode: 0o600 }));
    const script = liquidsoapConfig.generateScript(preparedConfig);
    const scriptPath = path.join(temporary, "autodj.liq");
    liquidsoapConfig.writeScript(scriptPath, script);
    checkScript(binary, scriptPath, runtimeConfig.server.password);
    if (!validationOnly) {
      preparedConfig.playlistSources = playlist.playlists.map((item) => ({
        id: item.id, playlistPath: item.outputFile, weight: item.weight,
      }));
      writePlaylists(playlist.playlists);
      liquidsoapConfig.writeScript(config.scriptPath, liquidsoapConfig.generateScript(preparedConfig));
    }
    return { binary, playlist, runtimeConfig: preparedConfig, scriptPath: validationOnly ? scriptPath : config.scriptPath };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function removePid(config) {
  processState.remove(config, process.pid);
}

function status(config) {
  return processState.status(config, "autodj");
}

async function start(config, argumentsList = []) {
  ensureDirectories(config);
  const current = status(config);
  if (current.running) {
    console.log("AutoDJ is already online.");
    return current.pid;
  }

  prepareRuntime(config);
  const entryPoint = path.join(config.serverRoot, "autodj.js");
  const child = childProcess.spawn(process.execPath, [entryPoint, "run_autodj", ...argumentsList], {
    cwd: config.autodjRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      RADIO_AUTODJ_BACKGROUND: "1",
    },
  });
  try {
    await processState.waitForReady(child);
    if (child.connected) child.disconnect();
    child.unref();
  } catch (error) {
    if (child.pid) {
      if (processState.read(config)?.pid === child.pid) {
        await processState.stop(config, "autodj");
      } else {
        child.kill("SIGTERM");
      }
      await processState.waitForExit(child);
    }
    throw new Error(`AutoDJ startup failed: ${error.message}. Check ${config.logPath}`);
  }
  console.log(`AutoDJ started in the background. Log: ${config.logPath}`);
  return child.pid;
}

async function runForeground(config, argumentsList = []) {
  ensureDirectories(config);
  const current = status(config);
  if (current.running && current.pid !== process.pid) {
    console.log("AutoDJ is already online.");
    return;
  }
  const runtime = prepareRuntime(config);
  const background = process.env.RADIO_AUTODJ_BACKGROUND === "1";
  const log = logRotation.createSessionLog(config.logPath, {
    maxBytes: runtime.runtimeConfig.logging.maxSizeMb * 1024 * 1024,
    maxFiles: runtime.runtimeConfig.logging.maxFiles,
  });
  let child;
  let shutdown = () => {};
  let failed = false;
  let finishStartup = () => {};
  log.on("error", (error) => {
    failed = true;
    process.exitCode = 1;
    console.error(`AutoDJ log error: ${error.message}`);
    shutdown();
  });
  try {
    finishStartup = beginChildStartup();
    child = childProcess.spawn(runtime.binary, liquidsoapRuntime.getArguments(runtime.binary, [...argumentsList, runtime.scriptPath]), {
      cwd: config.autodjRoot,
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    shutdown = processState.forwardSignals(child, { onOutputError(error) {
      failed = true;
      process.exitCode = 1;
      if (!log.destroyed && !log.writableEnded) log.write(`AutoDJ console output error: ${error.message}\n`);
    } });
    if (failed) shutdown();
  } catch (error) {
    if (log) log.end();
    if (!child?.pid) finishStartup();
    throw error;
  }

  const metadataLogger = Object.fromEntries(["log", "warn"].map((level) => [level, (message) => {
    if (!background) console[level](message);
    if (log && !log.writableEnded && !log.destroyed) log.write(`${message}\n`);
  }]));
  const publishers = new Map();
  for (const output of runtime.runtimeConfig.outputs.filter((item) => item.enabled)) {
    try {
      publishers.set(output.streamId, metadataRepair.startMetadataPublisher({
        serverRoot: config.serverRoot,
        logger: metadataLogger,
        streamIds: [output.streamId],
      }));
    } catch (error) {
      metadataLogger.warn(`[METADATA] SHOUTcast publisher for stream #${output.streamId} could not start: ${error.message}`);
    }
  }
  let repair = { stop() {} };
  try {
    repair = metadataRepair.startMetadataRepair({ serverRoot: config.serverRoot, logger: metadataLogger });
  } catch (error) {
    metadataLogger.warn(`[METADATA] Unicode repair could not start: ${error.message}`);
  }
  const metadataController = {
    publish(title, streamId) {
      publishers.get(streamId)?.publish(title);
    },
    stop() {
      for (const publisher of publishers.values()) publisher.stop();
      repair.stop();
    },
  };

  let startupComplete = false;
  const disconnected = () => {
    if (!startupComplete) {
      failed = true;
      process.exitCode = 1;
      shutdown();
    }
  };
  if (background && process.connected) process.once("disconnect", disconnected);
  const stdoutMetadata = metadataRepair.createMetadataLogParser(metadataController.publish);
  const stderrMetadata = metadataRepair.createMetadataLogParser(metadataController.publish);
  child.stdout.on("data", (chunk) => stdoutMetadata.write(chunk));
  child.stderr.on("data", (chunk) => stderrMetadata.write(chunk));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  if (!background) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  if (log) {
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
  }

  child.once("error", (error) => {
    failed = true;
    stdoutMetadata.end();
    stderrMetadata.end();
    metadataController.stop();
    if (log && !log.destroyed) log.end(`AutoDJ process error: ${error.message}\n`);
    removePid(config);
    console.error(`AutoDJ process error: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("close", (code, signal) => {
    process.removeListener("disconnect", disconnected);
    stdoutMetadata.end();
    stderrMetadata.end();
    metadataController.stop();
    if (log) log.end();
    removePid(config);
    process.exitCode = failed ? 1 : signal ? 0 : (code ?? 1);
  });
  try {
    await processState.waitForSpawn(child);
    if (failed) throw new Error("AutoDJ startup failed; check its logs");
    processState.save(config, process.pid, "autodj", { childPid: child.pid });
    finishStartup();
    if (process.connected && background) {
      startupComplete = true;
      await new Promise((resolve, reject) => process.send({ type: "radioserver:ready" },
        (error) => error ? reject(error) : resolve()));
    }
  } catch (error) {
    failed = true;
    process.exitCode = 1;
    metadataController.stop();
    shutdown();
    await processState.waitForExit(child);
    finishStartup();
    throw error;
  }
}

async function stop(config) {
  const stopped = await processState.stop(config, "autodj");
  console.log(stopped ? "AutoDJ has been stopped." : "AutoDJ is not online.");
}

module.exports = {
  findBinary,
  getConfig,
  loadConfiguration,
  prepareRuntime,
  parseVersion,
  runForeground,
  start,
  stop,
  status,
  versionIsSupported,
};
