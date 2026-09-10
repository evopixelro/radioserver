const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");

function expectedEntry(title, file) {
  const key = createHash("sha256").update(title.normalize("NFC").toLowerCase()).digest("hex");
  return `annotate:song=${JSON.stringify(title)},radio_track_key="${key}":${file}`;
}

const {
  formatPlaylistEntries,
  generatePlaylist,
  loadPlaylistConfig,
} = require("../app/playlist-generator");

test("requires an active config with the current playlists schema", (context) => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-playlist-required-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));

  assert.throws(
    () => loadPlaylistConfig({ serverRoot }),
    /Copy playlist\.config\.json\.example to playlist\.config\.json/,
  );
  fs.writeFileSync(
    path.join(serverRoot, "playlist.config.json"),
    JSON.stringify({ pathMode: "relative" }),
  );
  assert.throws(
    () => loadPlaylistConfig({ serverRoot }),
    /playlists must contain at least one playlist definition/,
  );
});

test("configuration template contains only universal", () => {
  const serverRoot = path.resolve(__dirname, "..");
  const configPath = path.join(serverRoot, "playlist.config.json.example");
  const config = loadPlaylistConfig({ serverRoot, configPath });
  assert.equal(config.configPath, configPath);
  assert.equal(config.playlists.length, 1);
  assert.equal(config.playlists[0].id, "universal");
  assert.equal(config.playlists[0].directory, path.join(serverRoot, "playlists", "universal"));
  assert.equal(config.playlists[0].outputFile, path.join(serverRoot, "playlists", "universal.lst"));
});

test("playlist outputs cannot alias the same destination through different directories", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-playlist-alias-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "lists"));
  fs.symlinkSync(path.join(root, "lists"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({ playlists: [
    { id: "universal", directory: "audio", outputFile: "lists/common.lst" },
    { id: "pop", directory: "audio", outputFile: "alias/common.lst" },
  ] }));
  assert.throws(() => loadPlaylistConfig({ serverRoot: root }), /outputFile is duplicated/);
});

test("macOS playlist output comparisons reject case-only collisions", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-playlist-case-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "playlist.config.json"), JSON.stringify({ playlists: [
    { id: "universal", directory: "audio", outputFile: "lists/Common.lst" },
    { id: "pop", directory: "audio", outputFile: "lists/common.lst" },
  ] }));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.throws(() => loadPlaylistConfig({ serverRoot: root }), /outputFile is duplicated/);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("writes UTF-8 playlist entries with a filename metadata fallback", (context) => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-playlist-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  const playlistDirectory = path.join(serverRoot, "playlists", "universal");
  fs.mkdirSync(playlistDirectory, { recursive: true });
  fs.writeFileSync(path.join(playlistDirectory, "Știință — Радио.mp3"), "test");
  fs.writeFileSync(
    path.join(serverRoot, "playlist.config.json"),
    JSON.stringify({
      playlists: [
        {
          id: "universal",
          directory: "playlists/universal",
          outputFile: "playlists/universal.lst",
        },
      ],
    }),
  );

  const result = generatePlaylist({ serverRoot });
  assert.deepEqual(result.entries, [
    expectedEntry("Știință — Радио", "playlists/universal/Știință — Радио.mp3"),
  ]);
  assert.equal(
    fs.readFileSync(path.join(serverRoot, "playlists", "universal.lst"), "utf8"),
    `${expectedEntry("Știință — Радио", "playlists/universal/Știință — Радио.mp3")}\n`,
  );
});

test("escapes quoted fallback metadata without changing the request path", () => {
  const entries = formatPlaylistEntries(
    ['/music/Artist - "Song", Live.mp3'],
    { pathMode: "absolute" },
    "/srv/radioserver",
  );

  assert.deepEqual(entries, [
    expectedEntry('Artist - "Song", Live', '/music/Artist - "Song", Live.mp3'),
  ]);
});

test("generates multiple enabled playlists independently", (context) => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-playlists-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  const universalDirectory = path.join(serverRoot, "playlists", "universal");
  const popDirectory = path.join(serverRoot, "playlists", "pop");
  fs.mkdirSync(universalDirectory, { recursive: true });
  fs.mkdirSync(popDirectory, { recursive: true });
  fs.writeFileSync(path.join(universalDirectory, "track.mp3"), "test");
  fs.writeFileSync(path.join(popDirectory, "hit.wav"), "test");
  fs.writeFileSync(
    path.join(serverRoot, "playlist.config.json"),
    JSON.stringify({
      playlists: [
        {
          id: "universal",
          directory: "playlists/universal",
          outputFile: "playlists/universal.lst",
          weight: 4,
        },
        {
          id: "pop",
          directory: "playlists/pop",
          outputFile: "playlists/pop.lst",
          weight: 1,
        },
      ],
    }),
  );

  const result = generatePlaylist({ serverRoot });
  assert.equal(result.playlists.length, 2);
  assert.equal(result.totalTracks, 2);
  assert.deepEqual(
    result.playlists.map(({ id, weight, entries }) => ({ id, weight, entries })),
    [
      {
        id: "universal",
        weight: 4,
        entries: [expectedEntry("track", "playlists/universal/track.mp3")],
      },
      {
        id: "pop",
        weight: 1,
        entries: [expectedEntry("hit", "playlists/pop/hit.wav")],
      },
    ],
  );
  assert.equal(
    fs.readFileSync(path.join(serverRoot, "playlists", "universal.lst"), "utf8"),
    `${expectedEntry("track", "playlists/universal/track.mp3")}\n`,
  );
  assert.equal(
    fs.readFileSync(path.join(serverRoot, "playlists", "pop.lst"), "utf8"),
    `${expectedEntry("hit", "playlists/pop/hit.wav")}\n`,
  );
});

test("rejects duplicate playlist ids", (context) => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-playlist-invalid-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(serverRoot, "playlist.config.json"),
    JSON.stringify({
      playlists: [
        { id: "same", directory: "one", outputFile: "one.lst" },
        { id: "same", directory: "two", outputFile: "two.lst" },
      ],
    }),
  );

  assert.throws(() => loadPlaylistConfig({ serverRoot }), /Playlist id is duplicated: same/);
});

test("repeat identity ignores directories, extensions, casing and Unicode normalization but permits another name", () => {
  const names = ["one/Și tu.mp3", "two/ȘI TU.flac", "three/S\u0326i tu.wav", "one/Și tu (Remix).mp3"];
  const entries = formatPlaylistEntries(names.map((name) => path.resolve(name)), { pathMode: "absolute" }, process.cwd());
  const keys = entries.map((entry) => /radio_track_key="([a-f0-9]{64})"/.exec(entry)[1]);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
  assert.notEqual(keys[0], keys[3]);
});
