const { withControlLock } = require("./control-lock");
const manager = require("./process-manager");

let parentDisconnected = false;
process.once("disconnect", () => { parentDisconnected = true; });
process.once("message", async (message) => {
  try {
    if (message?.type !== "radioserver:init") throw new Error("Invalid supervisor startup message");
    await withControlLock(message.config.runDirectory, () => {
      if (parentDisconnected) throw new Error("Startup controller disconnected");
      return manager.runForeground(message.config, message.arguments, { background: true });
    }, { inherited: true, timeoutMs: 30000, operation: "RadioServer run" });
  } catch (error) {
    process.exitCode = 1;
    if (process.connected) {
      process.send({ type: "radioserver:error", message: error.message }, () => {
        if (process.connected) process.disconnect();
      });
    }
  }
});
