const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { findActiveExamplePlaceholders } = require("./shoutcast-config");
const processState = require("./process-state");
const { createSessionLog } = require("./log-rotation");
const { assertLogSeparation } = require("./log-cleanup");
const { beginChildStartup } = require("./control-lock");

function getRunConfig(config, argumentsOverride) {
  const options = config.readRunOptions?.() || {};
  const argumentsList = argumentsOverride ?? config.arguments ?? options.arguments ?? [];
  if (!Array.isArray(argumentsList) || argumentsList.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("SHOUTcast arguments must be an array of strings without null characters.");
  }
  return {
    ...config,
    arguments: argumentsList,
    logOptions: config.logOptions ?? options.logOptions,
  };
}

function ensureDirectories(config) {
  fs.mkdirSync(config.runDirectory, { recursive: true, mode: 0o750 });
  fs.mkdirSync(config.logDirectory, { recursive: true, mode: 0o750 });
}

function assertExecutable(config) {
  try {
    if (!fs.statSync(config.binaryPath).isFile()) throw new Error("Not a regular file");
    if (config.runtimeProfile.family !== "windows" && config.binarySource === "platform") {
      fs.chmodSync(config.binaryPath, 0o755);
    }
    fs.accessSync(
      config.binaryPath,
      config.runtimeProfile.family === "windows" ? fs.constants.F_OK : fs.constants.X_OK,
    );
  } catch (error) {
    throw new Error(
      `SHOUTcast was not found or is not executable for ${config.runtimeProfile.id}: ${config.binaryPath}. ` +
        "Install the matching DNAS build or set SC_SERV_BIN to its executable.",
    );
  }
}

function assertConfiguration(config) {
  assertLogSeparation(config);
  if (!fs.existsSync(config.configPath)) {
    throw new Error(
      `Radio configuration was not found: ${config.configPath}. ` +
        "Copy sc_serv.conf.example to sc_serv.conf and configure it before starting.",
    );
  }

  const content = fs.readFileSync(config.configPath, "utf8");
  const placeholders = findActiveExamplePlaceholders(content);
  if (placeholders.length > 0) {
    throw new Error(
      `Radio configuration still contains active example placeholders ` +
        `(${placeholders.join(", ")}): ${config.configPath}`,
    );
  }
}

function getStatus(config) {
  return processState.status(config, "shoutcast");
}

function prepareRuntime(config, argumentsOverride) {
  const prepared = getRunConfig(config, argumentsOverride);
  assertExecutable(prepared);
  assertConfiguration(prepared);
  return prepared;
}

async function start(config, argumentsOverride) {
  ensureDirectories(config);

  const current = getStatus(config);
  if (current.running) {
    console.log("RadioServer is already online.");
    return current.pid;
  }

  config = prepareRuntime(config, argumentsOverride);

  const child = childProcess.spawn(process.execPath, [path.join(__dirname, "server-supervisor.js")], {
    cwd: config.serverRoot, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const ready = processState.waitForReady(child);
    child.send({ type: "radioserver:init", config, arguments: config.arguments }, (error) => {
      if (error) child.emit("error", error);
    });
    await ready;
    if (child.connected) child.disconnect();
    child.unref();
  } catch (error) {
    if (child.pid) {
      if (processState.read(config)?.pid === child.pid) await processState.stop(config, "shoutcast");
      else child.kill("SIGTERM");
      await processState.waitForExit(child);
    }
    throw error;
  }

  console.log(
    `RadioServer started in the background. Logs: ${config.stdoutLogPath} and ${config.stderrLogPath}`,
  );
  return child.pid;
}

async function runForeground(config, argumentsOverride, { background = false } = {}) {
  ensureDirectories(config);
  if (getStatus(config).running) {
    console.log("RadioServer is already online.");
    return;
  }
  config = prepareRuntime(config, argumentsOverride);

  let stdoutLog;
  let stderrLog;
  let child;
  let shutdown = () => {};
  let failed = false;
  let finishStartup = () => {};
  const logError = (error) => {
    failed = true;
    process.exitCode = 1;
    console.error(`RadioServer log error: ${error.message}`);
    shutdown();
  };
  try {
    stdoutLog = createSessionLog(config.stdoutLogPath, config.logOptions);
    stdoutLog.on("error", logError);
    stderrLog = createSessionLog(config.stderrLogPath, config.logOptions);
    stderrLog.on("error", logError);
    finishStartup = beginChildStartup();
    child = childProcess.spawn(config.binaryPath, [config.configPath, ...config.arguments], {
      cwd: config.serverRoot,
      windowsHide: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    shutdown = processState.forwardSignals(child, { onOutputError(error) {
      failed = true;
      process.exitCode = 1;
      if (!stderrLog.destroyed && !stderrLog.writableEnded) {
        stderrLog.write(`RadioServer console output error: ${error.message}\n`);
      }
    } });
    if (failed) shutdown();
  } catch (error) {
    stdoutLog?.end();
    stderrLog?.end();
    if (!child?.pid) finishStartup();
    throw error;
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  if (!background) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  child.stdout.pipe(stdoutLog, { end: false });
  child.stderr.pipe(stderrLog, { end: false });

  let startupComplete = false;
  const disconnected = () => { if (!startupComplete) { failed = true; shutdown(); } };
  if (background && process.connected) process.once("disconnect", disconnected);

  child.on("error", (error) => {
    failed = true;
    if (!stderrLog.destroyed && !stderrLog.writableEnded) stderrLog.write(`RadioServer process error: ${error.message}\n`);
    console.error(`RadioServer process error: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.removeListener("disconnect", disconnected);
    stdoutLog.end();
    stderrLog.end();
    processState.remove(config, process.pid);
    process.exitCode = failed ? 1 : signal ? 0 : (code ?? 1);
  });
  try {
    await processState.waitForSpawn(child);
    if (failed) throw new Error("RadioServer startup failed; check its logs");
    processState.save(config, process.pid, "shoutcast", { childPid: child.pid });
    finishStartup();
    if (background && process.connected) {
      startupComplete = true;
      await new Promise((resolve, reject) => process.send({ type: "radioserver:ready" },
        (error) => error ? reject(error) : resolve()));
    }
  } catch (error) {
    failed = true;
    process.exitCode = 1;
    shutdown();
    await processState.waitForExit(child);
    finishStartup();
    throw error;
  }
}

async function stop(config) {
  const stopped = await processState.stop(config, "shoutcast");
  console.log(stopped ? "RadioServer has been stopped." : "RadioServer is not online.");
}

function setup(config) {
  ensureDirectories(config);
  assertExecutable(config);
  const result = childProcess.spawnSync(config.binaryPath, ["setup"], {
    cwd: config.serverRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
  }
}

module.exports = {
  getRunConfig,
  getStatus,
  prepareRuntime,
  runForeground,
  start,
  stop,
  setup,
};
