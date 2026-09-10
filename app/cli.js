const config = require("./config");
const radio = require("./process-manager");
const autodj = require("./autodj-manager");
const doctor = require("./doctor");
const playlist = require("./playlist-cli");
const runtimeInstaller = require("./runtime-installer");
const codeUpdater = require("./code-updater");
const logConsole = require("./log-console");
const logCleanup = require("./log-cleanup");
const { withControlLock } = require("./control-lock");

const RECOVERY_COMMANDS = new Set([
  "help", "--help", "-h", "doctor", "status", "autodj-status",
  "stop", "autodj-stop", "stop_autodj", "console", "autodj-console", "console_autodj",
]);

const MUTATING_COMMANDS = new Set([
  "start", "run", "stop", "restart", "setup", "install", "update", "update_code", "playlist",
  "autodj-start", "start_autodj", "run_autodj", "autodj-stop", "stop_autodj", "autodj-restart",
  "clear_logs", "clear_logs_autodj",
]);

const REQUIRES_COMPLETE_UPDATE = new Set([
  "start", "run", "restart", "setup", "install", "update",
  "autodj-start", "start_autodj", "run_autodj", "autodj-restart",
]);

const EXTERNAL_TOOL_COMMANDS = new Set(["install", "update", "setup"]);

function isAutomaticNpmInstall(environment = process.env) {
  if (environment.npm_lifecycle_event !== "install") return false;

  const npmCommand = String(environment.npm_command || "").toLowerCase();
  if (npmCommand === "run" || npmCommand === "run-script") return false;

  if (environment.npm_config_argv) {
    try {
      const originalArguments = JSON.parse(environment.npm_config_argv).original;
      const originalCommand = Array.isArray(originalArguments)
        ? String(originalArguments[0] || "").toLowerCase()
        : "";
      if (originalCommand === "run" || originalCommand === "run-script") return false;
    } catch {
      // Ignore malformed metadata from older npm versions
    }
  }

  return true;
}

function usage(component = "server") {
  if (component === "autodj") {
    console.log(`Usage: node autodj.js [command] [options]

With no command, run AutoDJ in the foreground for Screen or another supervisor.

AutoDJ (Liquidsoap):
  start [args]                Generate, validate and start AutoDJ in the background
  stop                        Stop AutoDJ
  restart [args]              Regenerate, validate and restart AutoDJ
  status                      Show AutoDJ status
  console                     Follow AutoDJ logs without controlling the process
  clear_logs                  Empty the active AutoDJ log while stopped

Run 'node server.js --help' for installation and shared commands.`);
    return;
  }
  console.log(`Usage: node server.js [command] [options]

With no command, run SHOUTcast in the foreground for Screen or another supervisor.

RadioServer:
  start [sc_serv args]        Start RadioServer
  stop                        Stop RadioServer
  restart [sc_serv args]      Restart RadioServer
  status                      Show RadioServer and AutoDJ status
  console                     Follow RadioServer logs without controlling the process
  clear_logs                  Empty active RadioServer logs while stopped
  setup                       Run sc_serv setup
  doctor                      Check Node.js, binaries and runtime requirements
  install --accept-license    Download and install verified platform binaries
  update --accept-license     Refresh all repository-managed binaries
  update_code [options]       Update controller code from GitHub

AutoDJ (Liquidsoap):
  start_autodj [args]         Generate, validate and start AutoDJ
  stop_autodj                 Stop AutoDJ
  autodj-restart [args]       Regenerate, validate and restart AutoDJ
  autodj-status               Show AutoDJ status
  console_autodj              Follow AutoDJ logs without controlling the process
  clear_logs_autodj           Empty the active AutoDJ log while stopped

Playlist:
  playlist [options]          Generate the AutoDJ playlist

Run 'node server.js playlist --help' for playlist options.`);
}

function radioStatus() {
  const radioStatusValue = radio.getStatus(config);
  const autodjStatusValue = autodj.status(autodj.getConfig(config.serverRoot));
  console.log(radioStatusValue.running ? `RadioServer is running (PID ${radioStatusValue.pid}).` : "RadioServer is not running.");
  console.log(autodjStatusValue.running ? `AutoDJ is running (PID ${autodjStatusValue.pid}).` : "AutoDJ is not running.");
  if (!radioStatusValue.running && !autodjStatusValue.running) {
    process.exitCode = 3;
  }
}

async function dispatch(argumentsList) {
  const [command = "start", ...commandArguments] = argumentsList;
  const autodjConfig = autodj.getConfig(config.serverRoot);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    case "start":
      await radio.start(config, commandArguments.length ? commandArguments : config.arguments);
      return;
    case "run":
      await radio.runForeground(config, commandArguments.length ? commandArguments : config.arguments);
      return;
    case "stop":
      await radio.stop(config);
      return;
    case "restart": {
      const runConfig = radio.prepareRuntime(config, commandArguments.length ? commandArguments : undefined);
      await radio.stop(config);
      await radio.start(runConfig, runConfig.arguments);
      return;
    }
    case "status":
      radioStatus();
      return;
    case "console":
      if (commandArguments.length) throw new Error("Usage: node server.js console");
      await logConsole.followLogs([config.stdoutLogPath, config.stderrLogPath], { label: "RadioServer" });
      return;
    case "clear_logs": {
      if (commandArguments.length) throw new Error("Usage: node server.js clear_logs");
      const paths = logCleanup.assertLogSeparation(config, autodjConfig.logPath);
      const count = logCleanup.clearLogs(paths, { label: "RadioServer", running: radio.getStatus(config).running });
      console.log(`RadioServer logs cleared (${count} files). Archives were kept.`);
      return;
    }
    case "setup":
      radio.setup(config);
      return;
    case "doctor":
      doctor.runDoctor(config, autodj);
      return;
    case "install":
      if (isAutomaticNpmInstall()) {
        console.log(
          "Node.js dependencies are ready. Run 'npm run install' to install the radio runtimes.",
        );
        return;
      }
      await runtimeInstaller.installRuntime({
        acceptLicense: commandArguments.includes("--accept-license"),
      });
      return;
    case "update":
      await runtimeInstaller.installRuntime({
        acceptLicense: commandArguments.includes("--accept-license"),
        force: true,
      });
      return;
    case "update_code":
      await codeUpdater.updateCode(config, commandArguments);
      return;
    case "playlist":
      playlist.run(commandArguments);
      return;
    case "autodj-start":
    case "start_autodj":
      await autodj.start(autodjConfig, commandArguments);
      return;
    case "run_autodj":
      await autodj.runForeground(autodjConfig, commandArguments);
      return;
    case "autodj-stop":
    case "stop_autodj":
      await autodj.stop(autodjConfig);
      return;
    case "autodj-restart":
      autodj.prepareRuntime(autodjConfig, { validationOnly: true });
      await autodj.stop(autodjConfig);
      await autodj.start(autodjConfig, commandArguments);
      return;
    case "autodj-status": {
      const status = autodj.status(autodjConfig);
      console.log(status.running ? `AutoDJ is running (PID ${status.pid}).` : "AutoDJ is not running.");
      process.exitCode = status.running ? 0 : 3;
      return;
    }
    case "autodj-console":
    case "console_autodj":
      if (commandArguments.length) throw new Error("Usage: node autodj.js console");
      await logConsole.followLogs([autodjConfig.logPath], { label: "AutoDJ" });
      return;
    case "clear_logs_autodj": {
      if (commandArguments.length) throw new Error("Usage: node autodj.js clear_logs");
      logCleanup.assertLogSeparation(config, autodjConfig.logPath);
      const count = logCleanup.clearLogs([autodjConfig.logPath], { label: "AutoDJ", running: autodj.status(autodjConfig).running });
      console.log(`AutoDJ logs cleared (${count} files). Archives were kept.`);
      return;
    }
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

async function main(argumentsList = process.argv.slice(2)) {
  const command = argumentsList[0] || "start";
  const automaticInstall = command === "install" && isAutomaticNpmInstall();
  if (!automaticInstall && !RECOVERY_COMMANDS.has(command) && !doctor.versionIsSupported(process.version)) {
    throw new Error(`Node.js >=22.0.0 is required; current version is ${process.version}. Upgrade Node.js before running this command.`);
  }
  const codeCheck = command === "update_code" && codeUpdater.optionsFrom(argumentsList.slice(1)).check;
  const playlistPreview = command === "playlist" && argumentsList.some((arg) => ["--help", "--dry-run"].includes(arg));
  if (!MUTATING_COMMANDS.has(command) || codeCheck || automaticInstall || playlistPreview) {
    return dispatch(argumentsList);
  }
  return withControlLock(config.runDirectory, () => {
    if (REQUIRES_COMPLETE_UPDATE.has(command)) {
      codeUpdater.assertNoPendingUpdate(config.serverRoot);
    }
    return dispatch(argumentsList);
  }, {
    inherited: command === "run_autodj",
    timeoutMs: 30000,
    operation: /autodj/.test(command) ? `AutoDJ ${command.replace(/^autodj-/, "").replace(/_autodj$/, "")}` : `RadioServer ${command}`,
    recoverable: !EXTERNAL_TOOL_COMMANDS.has(command),
    onWait: (owner) => console.log(`Waiting for the previous controller operation to finish...${owner?.pid ? ` ${owner.operation || "Controller operation"} (PID ${owner.pid}).` : ""}`),
    onRecover: (owner) => console.log(`Recovered an abandoned controller lock (PID ${owner.pid}).`),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RadioServer error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { isAutomaticNpmInstall, main, usage };
