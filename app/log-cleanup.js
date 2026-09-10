const fs = require("node:fs");
const path = require("node:path");
const { parseShoutcastConfig } = require("./shoutcast-config");

function radioLogPaths(config) {
  const paths = [config.stdoutLogPath, config.stderrLogPath];
  let values;
  try { values = parseShoutcastConfig(fs.readFileSync(config.configPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return paths; throw error; }
  for (const [key, value] of values) {
    if (/^(?:logfile|w3clog|streamw3clog_\d+)$/.test(key) && value) {
      paths.push(path.resolve(config.serverRoot, value));
    }
  }
  return paths;
}

function canonicalPath(filePath) {
  const suffix = [];
  let current = path.resolve(filePath);
  while (true) {
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

function assertLogSeparation(config, autodjLogPath = path.join(config.logDirectory, "autodj.log")) {
  const radioPaths = radioLogPaths(config);
  const entries = [...radioPaths, autodjLogPath].map((filePath, index) => {
    let identity;
    try {
      const info = fs.statSync(filePath);
      if (info.ino) identity = `${info.dev}:${info.ino}`;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const canonical = canonicalPath(filePath);
    const { dir, name, ext } = path.parse(canonical);
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      filePath, canonical, identity, dir,
      managed: index < 2 || index === radioPaths.length,
      family: new RegExp(`^${escape(name)}(?:_[1-9][0-9]*)?${escape(ext)}$`),
    };
  });
  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index];
    for (const right of entries.slice(index + 1)) {
      if (!left.managed && !right.managed) continue;
      const sameFile = left.canonical === right.canonical || (left.identity && left.identity === right.identity);
      const sameFamily = left.dir === right.dir &&
        ((left.managed && left.family.test(path.basename(right.canonical))) ||
         (right.managed && right.family.test(path.basename(left.canonical))));
      if (sameFile || sameFamily) {
        throw new Error(`Log paths overlap: ${left.filePath} and ${right.filePath}. Use separate files for AutoDJ, SHOUTcast and captured output`);
      }
    }
  }
  return radioPaths;
}

function clearLogs(filePaths, { label, running }) {
  if (running) throw new Error(`Stop ${label} before clearing its logs`);
  const descriptors = [];
  try {
    for (const filePath of [...new Set(filePaths.map((value) => path.resolve(value)))]) {
      if (!/\.log$/i.test(filePath)) throw new Error(`Refusing to clear a file without a .log extension: ${filePath}`);
      let info;
      try { info = fs.lstatSync(filePath); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!info.isFile() || info.nlink !== 1) throw new Error(`Refusing to clear a linked or non-regular log: ${filePath}`);
      const fd = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      descriptors.push(fd);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) {
        throw new Error(`Log changed during cleanup: ${filePath}`);
      }
    }
    // Validate every target before clearing any contents
    for (const fd of descriptors) fs.ftruncateSync(fd, 0);
    return descriptors.length;
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}

module.exports = { assertLogSeparation, clearLogs, radioLogPaths };
