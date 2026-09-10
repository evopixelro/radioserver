const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_CONFIG,
  MP3_BITRATES,
  MP3_SAMPLE_RATES,
  generateScript,
  validateConfig,
} = require("../app/liquidsoap-config");

function createConfig(overrides = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.server.password = "production-secret";
  config.playlistSources = [
    {
      id: "universal",
      playlistPath: "/srv/radioserver/playlists/universal.lst",
      weight: 1,
    },
  ];
  return {
    ...config,
    ...overrides,
    normalization: { ...config.normalization, ...(overrides.normalization || {}) },
    server: { ...config.server, ...(overrides.server || {}) },
    outputs: overrides.outputs || config.outputs,
  };
}

test("generates a SHOUTcast MP3 320 kbps / 48 kHz output", () => {
  const script = generateScript(createConfig());

  assert.match(script, /output\.shoutcast\(/);
  assert.match(script, /%ffmpeg\(/);
  assert.match(script, /codec="libmp3lame"/);
  assert.match(script, /b="320k"/);
  assert.match(script, /samplerate=48000/);
  assert.match(script, /channels=2/);
  assert.match(script, /compression_level=0/);
  assert.match(script, /format="audio\/mpeg"/);
  assert.match(script, /icy_id=1/);
  assert.match(script, /encoding="UTF-8"/);
  assert.match(script, /icy_metadata=\["song"\]/);
  assert.match(script, /icy_song=radio_icy_song/);
  assert.match(script, /send_icy_metadata=true/);
  assert.match(script, /settings\.log\.level := 2/);
  assert.match(script, /reload=300,/);
});

test("uses the audio filename when artist and title tags are missing", () => {
  const script = generateScript(createConfig());

  assert.match(script, /def radio_song\(m\) =/);
  assert.match(script, /def radio_metadata_value_is_valid\(value\) =/);
  assert.match(script, /value != "" and value != "-" and value != "\."/);
  assert.match(script, /artist = string\.trim\(metadata\.artist\(m\)\)/);
  assert.match(script, /title = string\.trim\(metadata\.title\(m\)\)/);
  assert.match(
    script,
    /filename = string\.trim\(path\.remove_extension\(path\.basename\(metadata\.filename\(m\)\)\)\)/,
  );
  assert.match(script, /annotated_song = string\.trim\(m\["song"\]\)/);
  assert.match(script, /"#\{artist\} - #\{title\}"/);
  assert.match(script, /radio_metadata_value_is_valid\(annotated_song\)/);
  assert.match(script, /radio_metadata_value_is_valid\(filename\)/);
  assert.match(script, /"Unknown track"/);
  assert.match(script, /def radio_icy_song\(m\) =/);
  assert.match(script, /if song == "Unknown track" then/);
  assert.match(script, /def radio_metadata\(m\) =/);
  assert.match(script, /song = radio_song\(m\)/);
  assert.match(script, /def program_0_track\(m\) =/);
  assert.match(script, /json.stringify\(compact=true, radio_song\(m\)\)/);
  assert.match(script, /print\("\[RADIO_METADATA:1\] #\{song\}"\)/);
  assert.match(script, /\[\("title", song\)\]/);
  assert.match(
    script,
    /program_0 = metadata\.map\(id="autodj_program_0_metadata", strip=true, insert_missing=true, radio_metadata, program_0\)/,
  );
  assert.match(
    script,
    /program_0 = source\.on_metadata\(id="autodj_program_0_track_metadata", program_0, program_0_track\)/,
  );
});

test("accepts every standard MP3 output sample rate with an appropriate bitrate", () => {
  for (const sampleRate of MP3_SAMPLE_RATES) {
    const bitrateKbps = sampleRate >= 32000 ? 320 : 160;
    const config = createConfig();
    config.outputs[0] = { ...config.outputs[0], sampleRate, bitrateKbps };
    assert.doesNotThrow(() => validateConfig(config));
  }
});

test("accepts every MPEG-1 MP3 bitrate at 48 kHz, including 192 and 320 kbps", () => {
  for (const bitrateKbps of MP3_BITRATES) {
    if ([8, 16, 24, 144].includes(bitrateKbps)) continue;
    const config = createConfig();
    config.outputs[0] = { ...config.outputs[0], bitrateKbps, sampleRate: 48000 };
    assert.doesNotThrow(() => validateConfig(config));
  }
});

test("accepts every MPEG-2 MP3 bitrate at 24 kHz", () => {
  for (const bitrateKbps of [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]) {
    const config = createConfig();
    config.outputs[0] = { ...config.outputs[0], sampleRate: 24000, bitrateKbps };
    assert.doesNotThrow(() => validateConfig(config));
  }
});

test("rejects non-standard MP3 output sample rates", () => {
  for (const sampleRate of [96000, 192000]) {
    const config = createConfig();
    config.outputs[0] = { ...config.outputs[0], sampleRate };
    assert.throws(() => validateConfig(config), /does not support 96000 or 192000 Hz output/);
  }
});

test("rejects an invalid bitrate and sample-rate combination", () => {
  const config = createConfig();
  config.outputs[0] = { ...config.outputs[0], bitrateKbps: 320, sampleRate: 22050 };
  assert.throws(() => validateConfig(config), /invalid MP3 combination/);
});

test("generates multiple independent SHOUTcast stream IDs", () => {
  const config = createConfig({
    outputs: [
      { ...DEFAULT_CONFIG.outputs[0], id: "hq", streamId: 1 },
      {
        ...DEFAULT_CONFIG.outputs[0],
        id: "mobile",
        streamId: 2,
        bitrateKbps: 128,
        sampleRate: 44100,
      },
    ],
  });
  const script = generateScript(config);

  assert.equal((script.match(/output\.shoutcast\(/g) || []).length, 2);
  assert.match(script, /icy_id=1/);
  assert.match(script, /icy_id=2/);
});

test("combines multiple playlists using weighted rotation", () => {
  const script = generateScript(
    createConfig({
      playlistSources: [
        {
          id: "universal",
          playlistPath: "/srv/radioserver/playlists/universal.lst",
          weight: 4,
        },
        {
          id: "pop",
          playlistPath: "/srv/radioserver/playlists/pop.lst",
          weight: 1,
        },
      ],
    }),
  );

  assert.equal((script.match(/ = radio_program\(/g) || []).length, 1);
  assert.match(script, /id="autodj_program_0"/);
  assert.ok(script.includes('[{uri="/srv/radioserver/playlists/universal.lst", weight=4}, {uri="/srv/radioserver/playlists/pop.lst", weight=1}]'));
  assert.match(script, /request\.dynamic\(id=id, prefetch=1,/);
});

test("rejects duplicate enabled SHOUTcast stream IDs", () => {
  const config = createConfig({
    outputs: [
      { ...DEFAULT_CONFIG.outputs[0], id: "first", streamId: 1 },
      { ...DEFAULT_CONFIG.outputs[0], id: "second", streamId: 1 },
    ],
  });
  assert.throws(() => validateConfig(config), /streamId is duplicated/);
});

test("preserves Unicode metadata and safely quotes Liquidsoap strings", () => {
  const script = generateScript(
    createConfig({
      server: {
        password: 'secret\\with"quote',
        name: "Radio Știință — Радио",
      },
    }),
  );

  assert.match(script, /Radio Știință — Радио/);
  assert.match(script, /password="secret\\\\with\\"quote"/);
});

function multiPlaylistConfig(outputs) {
  return createConfig({
    playlistSources: [
      { id: "universal", playlistPath: "/radio/universal.lst", weight: 4 },
      { id: "pop", playlistPath: "/radio/pop.lst", weight: 1 },
    ],
    outputs: outputs.map((output, index) => ({
      ...DEFAULT_CONFIG.outputs[0], id: `output_${index}`, streamId: index + 1, ...output,
    })),
  });
}

test("missing and empty selections share the existing all-playlists programme", () => {
  const config = multiPlaylistConfig([{}, { playlists: [] }, { playlists: ["universal", "pop"] }]);
  delete config.outputs[0].playlists;
  const script = generateScript(config);
  assert.equal((script.match(/ = radio_program\(/g) || []).length, 1);
  assert.equal((script.match(/uri="\/radio\//g) || []).length, 2);
  assert.equal((script.match(/source\.on_metadata\(/g) || []).length, 1);
  assert.equal((script.match(/output\.shoutcast\(/g) || []).length, 3);
  assert.equal((script.match(/\n  program_0\n\)/g) || []).length, 3);
  for (const id of [1, 2, 3]) assert.ok(script.includes(`[RADIO_METADATA:${id}]`));
});

test("distinct selections feed only their own stream and do not load unused libraries", () => {
  const config = multiPlaylistConfig([{ playlists: ["universal"] }, { playlists: ["pop"] }]);
  config.playlistSources.push({ id: "rock", playlistPath: "/radio/rock.lst", weight: 1 });
  const script = generateScript(config);
  assert.match(script, /program_0 = radio_program\([\s\S]*?\[\{uri="\/radio\/universal.lst", weight=4\}\]/);
  assert.match(script, /program_1 = radio_program\([\s\S]*?\[\{uri="\/radio\/pop.lst", weight=1\}\]/);
  assert.doesNotMatch(script, /rock| = rotate\(/);
  assert.match(script, /id="shoutcast_output_0"[\s\S]*?icy_id=1[\s\S]*?\n  program_0\n\)/);
  assert.match(script, /id="shoutcast_output_1"[\s\S]*?icy_id=2[\s\S]*?\n  program_1\n\)/);
});

test("overlapping selections have independent playlist readers and audio processing", () => {
  const config = multiPlaylistConfig([{ playlists: [] }, { playlists: ["pop"] }]);
  config.crossfadeSeconds = 2;
  config.normalization.enabled = true;
  const script = generateScript(config);
  assert.equal((script.match(/ = radio_program\(/g) || []).length, 2);
  assert.equal((script.match(/uri="\/radio\/pop.lst"/g) || []).length, 2);
  assert.equal((script.match(/uri="\/radio\//g) || []).length, 3);
  for (const operator of ["metadata.map", "crossfade", "normalize", "mksafe", "source.on_metadata"]) {
    assert.equal(script.split(` = ${operator}(`).length - 1, 2, operator);
  }
});

test("explicit playlist order keeps its matching weights", () => {
  const script = generateScript(multiPlaylistConfig([
    { playlists: ["pop", "universal"] }, { playlists: ["universal", "pop"] },
  ]));
  assert.match(script, /program_0 = radio_program\([\s\S]*?\[\{uri="\/radio\/pop.lst", weight=1\}, \{uri="\/radio\/universal.lst", weight=4\}\]/);
  assert.match(script, /program_1 = radio_program\([\s\S]*?\[\{uri="\/radio\/universal.lst", weight=4\}, \{uri="\/radio\/pop.lst", weight=1\}\]/);
});

test("disabled outputs do not allocate a programme or require an active playlist reference", () => {
  const script = generateScript(multiPlaylistConfig([
    { playlists: ["universal"] }, { enabled: false, playlists: ["inactive"] },
  ]));
  assert.equal((script.match(/ = radio_program\(/g) || []).length, 1);
  assert.doesNotMatch(script, /program_1|RADIO_METADATA:2|inactive/);
});

for (const playlists of [null, "pop", {}, [null], [1], [""], ["../pop"], ["pop", "pop"]]) {
  test(`rejects malformed playlist selection ${JSON.stringify(playlists)}`, () => {
    assert.throws(() => generateScript(multiPlaylistConfig([{ playlists }])), /playlists/);
  });
}

for (const id of ["unknown", "Universal", "disabled"]) {
  test(`rejects unavailable playlist ${id} without silently using all playlists`, () => {
    assert.throws(() => generateScript(multiPlaylistConfig([{ playlists: [id] }])),
      new RegExp(`output_0.*unknown or disabled playlist "${id}"`));
  });
}
