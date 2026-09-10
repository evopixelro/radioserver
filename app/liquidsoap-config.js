const fs = require("node:fs");
const path = require("node:path");
const { parseJsonWithComments } = require("./json-config");
const { assertKnownKeys } = require("./config-validation");

const MP3_SAMPLE_RATES = new Set([
  8000,
  11025,
  12000,
  16000,
  22050,
  24000,
  32000,
  44100,
  48000,
]);
const MP3_BITRATES = new Set([
  8,
  16,
  24,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  144,
  160,
  192,
  224,
  256,
  320,
]);
const MPEG1_BITRATES = new Set([32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]);
const MPEG2_BITRATES = new Set([8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]);
const PLAYLIST_MODES = new Set(["normal", "random", "randomize"]);

const DEFAULT_CONFIG = Object.freeze({
  playlistMode: "randomize",
  playlistReloadSeconds: 300,
  crossfadeSeconds: 0,
  logging: { level: 2, maxSizeMb: 10, maxFiles: 5 },
  normalization: {
    enabled: false,
    targetLufs: -14,
  },
  server: {
    host: "127.0.0.1",
    port: 8000,
    password: "CHANGE_ME_STREAM_PASSWORD",
    name: "Radio Name",
    url: "https://example.com",
    genre: "Various",
    public: true,
  },
  outputs: [
    {
      id: "main",
      enabled: true,
      streamId: 1,
      playlists: [],
      codec: "mp3",
      bitrateKbps: 320,
      sampleRate: 48000,
      channels: 2,
      internalQuality: 0,
    },
  ],
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must not contain control characters.`);
}

function assertInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function assertNumber(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
}

function readJson(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `AutoDJ configuration was not found: ${configPath}. ` +
        "Copy autodj.config.json.example to autodj.config.json and configure it before starting.",
    );
  }

  try {
    return parseJsonWithComments(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`AutoDJ configuration is not valid JSON/JSONC: ${configPath}: ${error.message}`);
  }
}

function validateOutput(output, index) {
  const label = `outputs[${index}]`;
  assertPlainObject(output, label);
  assertString(output.id, `${label}.id`);
  if (!/^[a-zA-Z0-9_-]+$/.test(output.id)) {
    throw new Error(`${label}.id may contain only letters, numbers, underscores and hyphens.`);
  }
  if (typeof output.enabled !== "boolean") {
    throw new Error(`${label}.enabled must be true or false.`);
  }
  assertInteger(output.streamId, `${label}.streamId`, 1, 2147483647);
  if (output.playlists !== undefined) {
    if (!Array.isArray(output.playlists)) {
      throw new Error(`${label}.playlists must be an array of playlist IDs; use [] for all enabled playlists.`);
    }
    const ids = new Set();
    for (const id of output.playlists) {
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error(`${label}.playlists must contain valid playlist IDs.`);
      }
      if (ids.has(id)) throw new Error(`${label}.playlists contains a duplicate playlist ID: ${id}`);
      ids.add(id);
    }
  }
  if (output.codec !== "mp3") {
    throw new Error(`${label}.codec must be "mp3" for the supported SHOUTcast profile.`);
  }
  if (!MP3_BITRATES.has(output.bitrateKbps)) {
    throw new Error(
      `${label}.bitrateKbps must be a valid MP3 bitrate (${[...MP3_BITRATES].join(", ")} kbps).`,
    );
  }
  if (!MP3_SAMPLE_RATES.has(output.sampleRate)) {
    throw new Error(
      `${label}.sampleRate must be a standard MP3 rate (${[...MP3_SAMPLE_RATES].join(", ")} Hz). ` +
        "MP3/LAME does not support 96000 or 192000 Hz output.",
    );
  }
  const allowedBitrates = output.sampleRate >= 32000 ? MPEG1_BITRATES : MPEG2_BITRATES;
  if (!allowedBitrates.has(output.bitrateKbps)) {
    throw new Error(
      `${label} uses an invalid MP3 combination: ${output.bitrateKbps} kbps at ${output.sampleRate} Hz.`,
    );
  }
  if (![1, 2].includes(output.channels)) {
    throw new Error(`${label}.channels must be 1 (mono) or 2 (stereo).`);
  }
  assertInteger(output.internalQuality, `${label}.internalQuality`, 0, 9);
}

function validateConfig(config) {
  assertPlainObject(config, "AutoDJ configuration");
  if (!PLAYLIST_MODES.has(config.playlistMode)) {
    throw new Error('playlistMode must be "normal", "random" or "randomize".');
  }
  assertInteger(config.playlistReloadSeconds, "playlistReloadSeconds", 1, 3600);
  assertNumber(config.crossfadeSeconds, "crossfadeSeconds", 0, 30);
  assertPlainObject(config.logging, "logging");
  assertInteger(config.logging.level, "logging.level", 1, 5);
  assertInteger(config.logging.maxSizeMb, "logging.maxSizeMb", 1, 1024);
  assertInteger(config.logging.maxFiles, "logging.maxFiles", 1, 100);

  assertPlainObject(config.normalization, "normalization");
  if (typeof config.normalization.enabled !== "boolean") {
    throw new Error("normalization.enabled must be true or false.");
  }
  assertNumber(config.normalization.targetLufs, "normalization.targetLufs", -30, -5);

  assertPlainObject(config.server, "server");
  assertString(config.server.host, "server.host");
  if (/[\s/\\?#@]/.test(config.server.host)) throw new Error("server.host must be a hostname or IP address, not a URL.");
  assertInteger(config.server.port, "server.port", 1, 65534);
  assertString(config.server.password, "server.password");
  assertString(config.server.name, "server.name");
  assertString(config.server.url, "server.url");
  assertString(config.server.genre, "server.genre");
  if (typeof config.server.public !== "boolean") {
    throw new Error("server.public must be true or false.");
  }
  if (/CHANGE_ME|your_IP/i.test(config.server.password) || /CHANGE_ME|your_IP/i.test(config.server.host)) {
    throw new Error("AutoDJ configuration still contains an example password or host placeholder.");
  }

  if (!Array.isArray(config.outputs) || config.outputs.length === 0) {
    throw new Error("outputs must contain at least one SHOUTcast output.");
  }
  config.outputs.forEach(validateOutput);

  const enabled = config.outputs.filter((output) => output.enabled);
  if (enabled.length === 0) {
    throw new Error("At least one AutoDJ output must be enabled.");
  }
  const outputIds = new Set();
  const streamIds = new Set();
  for (const output of enabled) {
    if (outputIds.has(output.id)) {
      throw new Error(`Enabled AutoDJ output id is duplicated: ${output.id}`);
    }
    if (streamIds.has(output.streamId)) {
      throw new Error(`Enabled SHOUTcast streamId is duplicated: ${output.streamId}`);
    }
    outputIds.add(output.id);
    streamIds.add(output.streamId);
  }

  return config;
}

function loadConfig({ autodjRoot, configPath }) {
  const resolvedConfigPath = configPath || path.join(autodjRoot, "autodj.config.json");
  const raw = readJson(resolvedConfigPath);
  assertPlainObject(raw, "AutoDJ configuration");
  assertKnownKeys(raw, Object.keys(DEFAULT_CONFIG), "AutoDJ");
  if (raw.logging !== undefined) {
    assertPlainObject(raw.logging, "logging");
    assertKnownKeys(raw.logging, Object.keys(DEFAULT_CONFIG.logging), "logging");
  }
  if (raw.normalization !== undefined) {
    assertPlainObject(raw.normalization, "normalization");
    assertKnownKeys(raw.normalization, Object.keys(DEFAULT_CONFIG.normalization), "normalization");
  }
  if (raw.server !== undefined) {
    assertPlainObject(raw.server, "server");
    assertKnownKeys(raw.server, Object.keys(DEFAULT_CONFIG.server), "server");
  }
  if (raw.outputs !== undefined && !Array.isArray(raw.outputs)) {
    throw new Error("outputs must be a JSON array.");
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    logging: { ...DEFAULT_CONFIG.logging, ...(raw.logging || {}) },
    normalization: {
      ...DEFAULT_CONFIG.normalization,
      ...(raw.normalization || {}),
    },
    server: {
      ...DEFAULT_CONFIG.server,
      ...(raw.server || {}),
    },
    outputs: (raw.outputs ?? DEFAULT_CONFIG.outputs).map((output, index) => {
      assertPlainObject(output, `outputs[${index}]`);
      assertKnownKeys(output, Object.keys(DEFAULT_CONFIG.outputs[0]), `outputs[${index}]`);
      return { ...output };
    }),
  };
  validateConfig(config);

  return {
    ...config,
    configPath: resolvedConfigPath,
  };
}

function liquidsoapString(value) {
  return JSON.stringify(String(value));
}

function liquidsoapPath(value) {
  return liquidsoapString(String(value).replaceAll("\\", "/"));
}

function liquidsoapNumber(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function normalisePlaylistSources(config) {
  const rawSources = config.playlistSources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new Error("playlistSources must contain at least one enabled playlist.");
  }

  const ids = new Set();
  const playlistPaths = new Set();
  return rawSources.map((source, index) => {
    const label = `playlistSources[${index}]`;
    assertPlainObject(source, label);
    assertString(source.id, `${label}.id`);
    if (!/^[a-zA-Z0-9_-]+$/.test(source.id)) {
      throw new Error(`${label}.id may contain only letters, numbers, underscores and hyphens.`);
    }
    assertString(source.playlistPath, `${label}.playlistPath`);
    const weight = source.weight ?? 1;
    assertInteger(weight, `${label}.weight`, 1, 1000);
    if (ids.has(source.id)) {
      throw new Error(`Enabled playlist id is duplicated: ${source.id}`);
    }
    const comparablePath = process.platform === "win32"
      ? path.resolve(source.playlistPath).toLowerCase()
      : path.resolve(source.playlistPath);
    if (playlistPaths.has(comparablePath)) {
      throw new Error(`Enabled playlist path is duplicated: ${source.playlistPath}`);
    }
    ids.add(source.id);
    playlistPaths.add(comparablePath);
    return { id: source.id, playlistPath: source.playlistPath, weight };
  });
}

function resolvePrograms(config, playlistSources) {
  const available = new Map(playlistSources.map((source) => [source.id, source]));
  const programs = new Map();
  for (const output of config.outputs.filter((item) => item.enabled)) {
    const selected = output.playlists?.length ? output.playlists.map((id) => {
      const source = available.get(id);
      if (!source) throw new Error(`AutoDJ output "${output.id}" references unknown or disabled playlist "${id}".`);
      return source;
    }) : playlistSources;
    const key = JSON.stringify(selected.map((source) => source.id));
    if (!programs.has(key)) {
      programs.set(key, { name: `program_${programs.size}`, sources: selected, outputs: [] });
    }
    programs.get(key).outputs.push(output);
  }
  return [...programs.values()];
}

function renderOutput(output, server, source) {
  return `output.shoutcast(
  %ffmpeg(
    format="mp3",
    id3v2_version=0,
    write_xing=0,
    %audio(
      codec="libmp3lame",
      b="${output.bitrateKbps}k",
      samplerate=${output.sampleRate},
      channels=${output.channels},
      compression_level=${output.internalQuality}
    )
  ),
  id=${liquidsoapString(`shoutcast_${output.id}`)},
  format="audio/mpeg",
  host=${liquidsoapString(server.host)},
  port=${server.port},
  password=${liquidsoapString(server.password)},
  icy_id=${output.streamId},
  encoding="UTF-8",
  name=${liquidsoapString(server.name)},
  url=${liquidsoapString(server.url)},
  genre=${liquidsoapString(server.genre)},
  public=${server.public ? "true" : "false"},
  icy_metadata=["song"],
  icy_song=radio_icy_song,
  send_icy_metadata=true,
  ${source}
)`;
}

function generateScript(config) {
  validateConfig(config);
  const playlistSources = normalisePlaylistSources(config);
  const programs = resolvePrograms(config, playlistSources);

  const lines = [
    "# Generated by RadioServer, do not edit directly",
    "# Edit autodj.config.json and restart AutoDJ",
    "settings.log.file := false",
    "settings.log.stdout := true",
    `settings.log.level := ${config.logging.level}`,
    "",
    fs.readFileSync(path.join(__dirname, "autodj-playlist.liq"), "utf8").trimEnd(),
    "",
    "def radio_metadata_value_is_valid(value) =",
    '  value != "" and value != "-" and value != "."',
    "end",
    "",
    "def radio_song(m) =",
    "  artist = string.trim(metadata.artist(m))",
    "  title = string.trim(metadata.title(m))",
    "  filename = string.trim(path.remove_extension(path.basename(metadata.filename(m))))",
    '  annotated_song = string.trim(m["song"])',
    "  if radio_metadata_value_is_valid(artist) and radio_metadata_value_is_valid(title) then",
    '    "#{artist} - #{title}"',
    "  elsif radio_metadata_value_is_valid(title) then",
    "    title",
    "  elsif radio_metadata_value_is_valid(artist) then",
    "    artist",
    "  elsif radio_metadata_value_is_valid(annotated_song) then",
    "    annotated_song",
    "  elsif radio_metadata_value_is_valid(filename) then",
    "    filename",
    "  else",
    '    "Unknown track"',
    "  end",
    "end",
    "",
    "def radio_icy_song(m) =",
    "  song = radio_song(m)",
    '  if song == "Unknown track" then',
    "    null()",
    "  else",
    "    null(song)",
    "  end",
    "end",
    "",
    "def radio_metadata(m) =",
    "  song = radio_song(m)",
    '  [("title", song)]',
    "end",
  ];

  for (const program of programs) {
    const { name, sources, outputs } = program;
    lines.push("", `def ${name}_track(m) =`, "  song = json.stringify(compact=true, radio_song(m))");
    for (const output of outputs) {
      lines.push(`  print("[RADIO_METADATA:${output.streamId}] #{song}")`);
    }
    lines.push("end");

    lines.push(
      "", `${name} = radio_program(`,
      `  id=${liquidsoapString(`autodj_${name}`)},`,
      `  mode=${liquidsoapString(config.playlistMode)},`,
      `  reload=${config.playlistReloadSeconds},`,
      `  [${sources.map((source) => `{uri=${liquidsoapPath(source.playlistPath)}, weight=${source.weight}}`).join(", ")}]`,
      ")",
    );

    lines.push(
      "",
      `${name} = metadata.map(id="autodj_${name}_metadata", strip=true, insert_missing=true, radio_metadata, ${name})`,
    );
    if (config.crossfadeSeconds > 0) {
      lines.push("", `${name} = crossfade(duration=${liquidsoapNumber(config.crossfadeSeconds)}, ${name})`);
    }
    if (config.normalization.enabled) {
      lines.push("", `${name} = normalize(target=${liquidsoapNumber(config.normalization.targetLufs)}, lufs=true, ${name})`);
    }

    lines.push(
      "", `${name} = mksafe(${name})`,
      "%ifversion >= 2.4",
      `${name}.on_metadata(synchronous=true, ${name}_track)`,
      "%else",
      `${name} = source.on_metadata(id="autodj_${name}_track_metadata", ${name}, ${name}_track)`,
      "%endif", "",
      outputs.map((output) => renderOutput(output, config.server, name)).join("\n\n"),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function writeScript(scriptPath, content) {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true, mode: 0o750 });
  const temporaryPath = `${scriptPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, scriptPath);
    fs.chmodSync(scriptPath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

module.exports = {
  DEFAULT_CONFIG,
  MP3_BITRATES,
  MP3_SAMPLE_RATES,
  generateScript,
  loadConfig,
  validateConfig,
  writeScript,
};
