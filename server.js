async function main(argumentsList = process.argv.slice(2)) {
  return require("./app/cli").main(argumentsList.length ? argumentsList : ["run"]);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`RadioServer error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
