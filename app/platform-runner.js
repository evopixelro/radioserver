async function run(argumentsList = process.argv.slice(2)) {
  const [selection, component, action = "start", ...commandArguments] = argumentsList;
  if (!selection || !component || !["server", "autodj"].includes(component)) {
    console.error("Usage: node app/platform-runner.js <platform> <server|autodj> [action] [arguments]");
    process.exitCode = 2;
    return;
  }

  process.env.RADIO_PLATFORM = selection;
  const entrypoint = component === "autodj" ? require("../autodj") : require("../server");
  await entrypoint.main([action, ...commandArguments]);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`RadioServer error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
