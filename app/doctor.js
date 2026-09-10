const fs = require("node:fs");
const path = require("node:path");
const dependencies = require("./dependencies");
const { loadPlaylistConfig } = require("./playlist-generator");
const { configurationIsReady: shoutcastConfigurationIsReady, parseShoutcastConfig } = require("./shoutcast-config");
const { loadMetadataConfig } = require("./metadata-repair");
const systemDependencies = require("./system-dependencies");
const { assertLogSeparation } = require("./log-cleanup");

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "freebsd", "win32"]);

function versionIsSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  return Number(match[1]) >= 22;
}

function fileIsExecutable(filePath) {
  try {
    fs.accessSync(filePath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function configurationIsReady(filePath) {
  if (!fs.existsSync(filePath)) return false;
  return shoutcastConfigurationIsReady(fs.readFileSync(filePath, "utf8"));
}

function validateSourceLink(content, runtime) {
  const values = parseShoutcastConfig(content);
  const port = values.get("portbase") || "8000";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65534) {
    throw new Error("DNAS PortBase must be between 1 and 65534; ICY also uses PortBase + 1.");
  }
  if (runtime.server.port !== Number(port)) throw new Error("AutoDJ server.port must match DNAS PortBase.");
  for (const output of runtime.outputs.filter((item) => item.enabled)) {
    const slot = [...values].find(([key, value]) => /^streamid_\d+$/.test(key) && Number(value) === output.streamId)?.[0].slice(9);
    if (!slot && values.get("requirestreamconfigs") === "1") {
      throw new Error(`DNAS has no streamid_N configured for AutoDJ stream #${output.streamId}.`);
    }
    const password = values.get(`streampassword_${slot || output.streamId}`) || values.get("password");
    if (!password || password !== runtime.server.password) {
      throw new Error(`AutoDJ source password does not match DNAS stream #${output.streamId}.`);
    }
  }
}

function runDoctor(config, autodjManager) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  add(versionIsSupported(process.version), "Node.js", `${process.version} (requires Node.js >=22.0.0)`);
  add(SUPPORTED_PLATFORMS.has(process.platform), "Platform", config.runtimeProfile.id);
  add(fileIsExecutable(config.binaryPath), "Radio binary", config.binaryPath);
  if (fileIsExecutable(config.binaryPath)) {
    const native = systemDependencies.inspect(config.binaryPath, config.runtimeProfile);
    add(native.checked && !native.missing.length && !native.abiError, "SHOUTcast native dependencies",
      native.inspectionError || native.missing.join(", ") || (native.abiError ? "incompatible ABI" : native.checked ? "loader inspection completed" : "could not inspect this executable"));
  }
  add(
    configurationIsReady(config.configPath),
    "Radio configuration",
    fs.existsSync(config.configPath)
      ? `${config.configPath} (must not contain example placeholders)`
      : "copy sc_serv.conf.example to sc_serv.conf",
  );

  const autodjConfig = autodjManager.getConfig(config.serverRoot);
  try {
    config.readRunOptions?.();
    add(true, "SHOUTcast launch options", "Log limits and extra arguments are valid");
  } catch (error) { add(false, "SHOUTcast launch options", error.message); }
  try {
    assertLogSeparation(config, autodjConfig.logPath);
    add(true, "Log paths", "AutoDJ, SHOUTcast native logs and captured output are separate");
  } catch (error) { add(false, "Log paths", error.message); }
  let liquidsoapReady = false;
  try {
    add(true, "Liquidsoap", autodjManager.findBinary(autodjConfig));
    liquidsoapReady = true;
  } catch (error) {
    add(false, "Liquidsoap", error.message);
  }
  let autodjConfigurationReady = false;
  try {
    const runtimeConfig = autodjManager.loadConfiguration(autodjConfig);
    add(true, "AutoDJ configuration", autodjConfig.configPath);
    validateSourceLink(fs.readFileSync(config.configPath, "utf8"), runtimeConfig);
    add(true, "AutoDJ / DNAS source settings", "PortBase, source passwords and configured stream IDs match");
    for (const output of runtimeConfig.outputs.filter((item) => item.enabled)) {
      const metadata = loadMetadataConfig(config.serverRoot, { ...process.env, SC_SERV_CONFIG: config.configPath }, output.streamId);
      add(metadata.passwords.length > 0 && metadata.passwords.every((value) => !/CHANGE_ME/i.test(value)),
        `Metadata stream #${output.streamId}`, `${metadata.baseUrl.origin} (requires a configured administrator password)`);
    }
    autodjConfigurationReady = true;
  } catch (error) {
    add(false, "AutoDJ configuration", error.message);
  }

  const playlistConfigPath = path.join(config.serverRoot, "playlist.config.json");
  if (!fs.existsSync(playlistConfigPath)) {
    add(false, "Playlist configuration", "copy playlist.config.json.example to playlist.config.json");
  } else {
    try {
      const loadedPlaylistConfig = loadPlaylistConfig({
        serverRoot: config.serverRoot,
        configPath: playlistConfigPath,
      });
      add(
        true,
        "Playlist configuration",
        playlistConfigPath,
      );
      for (const playlist of loadedPlaylistConfig.playlists) {
        const isDirectory =
          fs.existsSync(playlist.directory) && fs.statSync(playlist.directory).isDirectory();
        add(isDirectory, `Playlist directory [${playlist.id}]`, playlist.directory);
      }
    } catch (error) {
      add(false, "Playlist configuration", error.message);
    }
  }

  const dependencyStatus = dependencies.getDependencyStatus({ serverRoot: config.serverRoot });
  add(
    !dependencyStatus.applicable || dependencyStatus.missing.length === 0,
    "Runtime dependencies",
    dependencyStatus.detail,
  );

  if (liquidsoapReady && autodjConfigurationReady) {
    try {
      const runtime = autodjManager.prepareRuntime(autodjConfig, { validationOnly: true });
      for (const output of runtime.runtimeConfig.outputs.filter((item) => item.enabled)) {
        const ids = output.playlists?.length ? output.playlists : runtime.playlist.playlists.map((item) => item.id);
        add(true, `Playlists stream #${output.streamId}`, ids.join(", "));
      }
      add(
        true,
        "AutoDJ preflight",
        `${runtime.playlist.totalTracks} track(s), generated Liquidsoap script accepted`,
      );
    } catch (error) {
      add(false, "AutoDJ preflight", error.message);
    }
  }

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.label}: ${check.detail}`);
  }

  const failures = checks.filter((check) => !check.ok).length;
  if (failures > 0) {
    throw new Error(`Doctor found ${failures} production requirement${failures === 1 ? "" : "s"} that need attention.`);
  }

  console.log("Local preflight passed. Verify live audio, title updates and restart recovery before production deployment.");
}

module.exports = { runDoctor, validateSourceLink, versionIsSupported };
