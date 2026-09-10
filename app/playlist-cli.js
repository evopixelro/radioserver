const path = require("node:path");
const { generatePlaylist } = require("./playlist-generator");

function usage() {
  console.log(`Usage: playlist [options]

Options:
  --config <file>       JSON configuration file
  --playlist-dir <dir>  Override the directory when one playlist is enabled
  --output <file>       Override the output when one playlist is enabled
  --absolute            Write absolute audio paths
  --shuffle             Randomise playlist order
  --no-recursive        Only scan the top-level audio directory
  --dry-run             Print entries without writing a file
  --help                Show this help`);
}

function parseArguments(argumentsList) {
  const result = { overrides: {} };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    switch (argument) {
      case "--config":
        index += 1;
        if (index >= argumentsList.length || argumentsList[index].startsWith("--")) throw new Error("--config requires a file path.");
        result.configPath = argumentsList[index];
        break;
      case "--playlist-dir":
        index += 1;
        if (index >= argumentsList.length || argumentsList[index].startsWith("--")) throw new Error("--playlist-dir requires a directory path.");
        result.overrides.directory = argumentsList[index];
        break;
      case "--output":
        index += 1;
        if (index >= argumentsList.length || argumentsList[index].startsWith("--")) throw new Error("--output requires a file path.");
        result.overrides.outputFile = argumentsList[index];
        break;
      case "--absolute":
        result.overrides.pathMode = "absolute";
        break;
      case "--shuffle":
        result.overrides.shuffle = true;
        break;
      case "--no-recursive":
        result.overrides.recursive = false;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--help":
        result.help = true;
        break;
      default:
        throw new Error(`Unknown playlist option: ${argument}`);
    }
  }
  return result;
}

function run(argumentsList = []) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    usage();
    return { help: true };
  }

  const serverRoot = path.resolve(__dirname, "..");
  const result = generatePlaylist({ serverRoot, ...options });
  if (result.dryRun) {
    if (result.playlists.length === 1) {
      process.stdout.write(result.entries.length ? `${result.entries.join("\n")}\n` : "");
    } else {
      const sections = result.playlists.map((playlist) =>
        [`# ${playlist.id}`, ...playlist.entries].join("\n"),
      );
      process.stdout.write(`${sections.join("\n\n")}\n`);
    }
    return result;
  }

  for (const playlist of result.playlists) {
    console.log(`Playlist generated [${playlist.id}]: ${playlist.outputFile}`);
    console.log(`Tracks [${playlist.id}]: ${playlist.entries.length}`);
  }
  if (result.playlists.length > 1) {
    console.log(`Total tracks: ${result.totalTracks}`);
  }
  return result;
}

if (require.main === module) {
  require("./cli").main(["playlist", ...process.argv.slice(2)]).catch((error) => {
    console.error(`Playlist error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, usage };
