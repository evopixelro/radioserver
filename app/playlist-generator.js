const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parseJsonWithComments } = require("./json-config");
const { assertKnownKeys } = require("./config-validation");

const DEFAULT_EXTENSIONS = [
  ".mp3",
  ".ogg",
  ".opus",
  ".aac",
  ".m4a",
  ".wav",
  ".flac",
  ".aif",
  ".aiff",
  ".wma",
  ".webm",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Playlist configuration was not found: ${configPath}. ` +
        "Copy playlist.config.json.example to playlist.config.json before starting AutoDJ.",
    );
  }

  try {
    const config = parseJsonWithComments(fs.readFileSync(configPath, "utf8"));
    if (!isPlainObject(config)) {
      throw new Error("the root value must be a JSON object");
    }
    return config;
  } catch (error) {
    throw new Error(`Playlist configuration is not valid JSON/JSONC: ${configPath}: ${error.message}`);
  }
}

function resolvePath(value, baseDirectory) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDirectory, value);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function canonicalOutput(file) {
  const suffix = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      const resolved = path.join(fs.realpathSync(current), ...suffix);
      return ["win32", "darwin"].includes(process.platform) ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function normaliseExtensions(extensions, label = "extensions") {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error(`${label} must be a non-empty JSON array.`);
  }

  const normalised = extensions.map((extension, index) => {
    assertNonEmptyString(extension, `${label}[${index}]`);
    const value = extension.toLowerCase();
    return value.startsWith(".") ? value : `.${value}`;
  });
  return [...new Set(normalised)];
}

function validateSharedOptions(options, label) {
  if (!["relative", "absolute"].includes(options.pathMode)) {
    throw new Error(`${label}.pathMode must be either "relative" or "absolute".`);
  }
  if (typeof options.recursive !== "boolean") {
    throw new Error(`${label}.recursive must be true or false.`);
  }
  if (typeof options.shuffle !== "boolean") {
    throw new Error(`${label}.shuffle must be true or false.`);
  }
  return {
    ...options,
    extensions: normaliseExtensions(options.extensions, `${label}.extensions`),
  };
}

function normalisePlaylist(entry, index, shared, configDirectory) {
  const label = `playlists[${index}]`;
  if (!isPlainObject(entry)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  assertKnownKeys(entry, ["id", "enabled", "directory", "outputFile", "weight", "pathMode", "recursive", "shuffle", "extensions"], label);

  assertNonEmptyString(entry.id, `${label}.id`);
  if (!/^[a-zA-Z0-9_-]+$/.test(entry.id)) {
    throw new Error(`${label}.id may contain only letters, numbers, underscores and hyphens.`);
  }
  assertNonEmptyString(entry.directory, `${label}.directory`);
  assertNonEmptyString(entry.outputFile, `${label}.outputFile`);
  if (!/\.lst$/i.test(entry.outputFile) || /[\r\n\0]/.test(entry.outputFile)) {
    throw new Error(`${label}.outputFile must be a .lst file, never a config, script or audio file.`);
  }

  const enabled = entry.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error(`${label}.enabled must be true or false.`);
  }
  const weight = entry.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
    throw new Error(`${label}.weight must be an integer between 1 and 1000.`);
  }

  const options = validateSharedOptions(
    {
      pathMode: entry.pathMode ?? shared.pathMode,
      recursive: entry.recursive ?? shared.recursive,
      shuffle: entry.shuffle ?? shared.shuffle,
      extensions: entry.extensions ?? shared.extensions,
    },
    label,
  );

  return {
    id: entry.id,
    enabled,
    directory: resolvePath(entry.directory, configDirectory),
    outputFile: resolvePath(entry.outputFile, configDirectory),
    weight,
    ...options,
  };
}

function loadPlaylistConfig({ serverRoot, configPath, overrides = {} }) {
  assertNonEmptyString(serverRoot, "serverRoot");
  if (!isPlainObject(overrides)) {
    throw new Error("Playlist overrides must be a JSON object.");
  }

  const resolvedServerRoot = path.resolve(serverRoot);
  const resolvedConfigPath = configPath
    ? path.resolve(configPath)
    : path.join(resolvedServerRoot, "playlist.config.json");
  const fileConfig = parseConfig(resolvedConfigPath);
  assertKnownKeys(fileConfig, ["pathMode", "recursive", "shuffle", "extensions", "playlists"], "playlist");
  const configDirectory = path.dirname(resolvedConfigPath);
  const shared = validateSharedOptions(
    {
      pathMode: overrides.pathMode ?? fileConfig.pathMode ?? "relative",
      recursive: overrides.recursive ?? fileConfig.recursive ?? true,
      shuffle: overrides.shuffle ?? fileConfig.shuffle ?? false,
      extensions: overrides.extensions ?? fileConfig.extensions ?? DEFAULT_EXTENSIONS,
    },
    "Playlist configuration",
  );

  if (!Array.isArray(fileConfig.playlists) || fileConfig.playlists.length === 0) {
    throw new Error("playlists must contain at least one playlist definition.");
  }
  fileConfig.playlists.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`playlists[${index}] must be a JSON object.`);
    }
  });
  const declarations = fileConfig.playlists.map((entry) => ({ ...entry }));

  const enabledCount = declarations.filter((entry) => entry.enabled !== false).length;
  if ((overrides.directory !== undefined || overrides.outputFile !== undefined) && enabledCount !== 1) {
    throw new Error("--playlist-dir and --output can only be used when exactly one playlist is enabled.");
  }
  if (enabledCount === 1) {
    const enabledIndex = declarations.findIndex((entry) => entry.enabled !== false);
    if (overrides.directory !== undefined) {
      declarations[enabledIndex].directory = overrides.directory;
    }
    if (overrides.outputFile !== undefined) {
      declarations[enabledIndex].outputFile = overrides.outputFile;
    }
  }

  const configuredPlaylists = declarations.map((entry, index) =>
    normalisePlaylist(entry, index, shared, configDirectory),
  );
  const ids = new Set();
  const outputFiles = new Set();
  for (const playlist of configuredPlaylists) {
    assertOutputFile(playlist.outputFile);
    if (path.resolve(playlist.outputFile).toLowerCase() === resolvedConfigPath.toLowerCase()) {
      throw new Error("A playlist must not overwrite its configuration file.");
    }
    const normalisedOutput = canonicalOutput(playlist.outputFile);
    if (ids.has(playlist.id)) {
      throw new Error(`Playlist id is duplicated: ${playlist.id}`);
    }
    if (outputFiles.has(normalisedOutput)) {
      throw new Error(`Playlist outputFile is duplicated: ${playlist.outputFile}`);
    }
    ids.add(playlist.id);
    outputFiles.add(normalisedOutput);
  }

  const playlists = configuredPlaylists.filter((playlist) => playlist.enabled);
  if (playlists.length === 0) {
    throw new Error("At least one playlist must be enabled.");
  }

  const result = {
    configPath: resolvedConfigPath,
    entryBaseDirectory: resolvedServerRoot,
    playlists,
    configuredPlaylists,
    ...shared,
  };
  return result;
}

function collectAudioFiles(directory, { recursive, extensions }) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Audio directory does not exist: ${directory}`);
  }
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`Audio path is not a directory: ${directory}`);
  }

  const files = [];
  const visit = (currentDirectory) => {
    const entries = fs.readdirSync(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(entryPath);
        continue;
      }
      if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        if (/\r|\n/.test(entryPath)) {
          throw new Error(`Audio filename contains a line break and cannot be listed safely: ${entryPath}`);
        }
        files.push(entryPath);
      }
    }
  };

  visit(directory);
  return files.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function formatPlaylistEntries(files, config, entryBaseDirectory) {
  return files.map((filePath) => {
    const requestPath = config.pathMode === "absolute"
      ? filePath.split(path.sep).join("/")
      : path.relative(entryBaseDirectory, filePath).split(path.sep).join("/");
    const fallbackSong = path.basename(filePath, path.extname(filePath));
    const trackKey = crypto.createHash("sha256").update(fallbackSong.normalize("NFC").toLowerCase()).digest("hex");
    return `annotate:song=${JSON.stringify(fallbackSong)},radio_track_key="${trackKey}":${requestPath}`;
  });
}

function writeAtomically(outputFile, content) {
  assertOutputFile(outputFile);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o750 });
  const temporaryFile = `${outputFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryFile, content, { encoding: "utf8", mode: 0o640 });
    fs.renameSync(temporaryFile, outputFile);
    fs.chmodSync(outputFile, 0o640);
  } finally {
    try {
      fs.unlinkSync(temporaryFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function assertOutputFile(outputFile) {
  try {
    if (!fs.lstatSync(outputFile).isFile()) {
      throw new Error(`Playlist output must be a regular file, not a directory or symlink: ${outputFile}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function writePlaylists(playlists) {
  for (const playlist of playlists) assertOutputFile(playlist.outputFile);
  for (const playlist of playlists) writeAtomically(playlist.outputFile, `${playlist.entries.join("\n")}\n`);
}

function generatePlaylist({ serverRoot, configPath, overrides = {}, dryRun = false }) {
  const config = loadPlaylistConfig({ serverRoot, configPath, overrides });
  const generatedPlaylists = config.playlists.map((playlist) => {
    let files = collectAudioFiles(playlist.directory, playlist);
    if (playlist.shuffle) files = shuffle(files);
    const entries = formatPlaylistEntries(files, playlist, config.entryBaseDirectory);
    if (!entries.length) {
      throw new Error(`AutoDJ playlist "${playlist.id}" is empty: add supported audio files to ${playlist.directory}.`);
    }
    return { ...playlist, entries };
  });

  if (!dryRun) {
    writePlaylists(generatedPlaylists);
  }

  const entries = generatedPlaylists.flatMap((playlist) => playlist.entries);
  const result = {
    ...config,
    playlists: generatedPlaylists,
    entries,
    totalTracks: entries.length,
    dryRun,
  };
  return result;
}

module.exports = {
  DEFAULT_EXTENSIONS,
  formatPlaylistEntries,
  generatePlaylist,
  loadPlaylistConfig,
  writePlaylists,
};
