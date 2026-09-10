const COMMANDS = new Map([
  ["run", "run_autodj"],
  ["start", "start_autodj"],
  ["stop", "stop_autodj"],
  ["restart", "autodj-restart"],
  ["status", "autodj-status"],
  ["console", "console_autodj"],
  ["clear_logs", "clear_logs_autodj"],
]);

async function main(argumentsList = process.argv.slice(2)) {
  const [command = "run", ...commandArguments] = argumentsList;
  // Platform selection must be set before loading the controller configuration
  const cli = require("./app/cli");
  if (["help", "--help", "-h"].includes(command)) return cli.usage("autodj");
  return cli.main([COMMANDS.get(command) || command, ...commandArguments]);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`AutoDJ error: ${error.message}`);
    process.exitCode = 1;
    if (process.env.RADIO_AUTODJ_BACKGROUND === "1" && process.connected) {
      process.send({ type: "radioserver:error", message: error.message }, () => {
        if (process.connected) process.disconnect();
      });
    }
  });
}

module.exports = { main };
