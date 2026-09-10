const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");

function openSessionLog(logPath, { maxFiles = 5 } = {}) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) throw new Error("Log retention must be between 1 and 100 archives");
  const { dir, name, ext } = path.parse(path.resolve(logPath));
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  let current;
  try {
    current = fs.lstatSync(logPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  {
    if (current && !current.isFile()) throw new Error(`Log rotation requires a regular file: ${logPath}`);
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escape(name)}_([1-9][0-9]*)${escape(ext)}$`);
    const archives = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const match = pattern.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile()) {
        throw new Error(`Log rotation requires a regular file: ${path.join(dir, entry.name)}`);
      }
      archives.push({ filePath: path.join(dir, entry.name), index: BigInt(match[1]) });
    }
    archives.sort((left, right) => left.index > right.index ? -1 : 1);
    if (current) archives.push({ filePath: logPath, index: 0n });
    for (const archive of archives) {
      if (archive.index + (current ? 1n : 0n) > BigInt(maxFiles)) {
        fs.unlinkSync(archive.filePath);
        continue;
      }
      if (!current) continue;
      const destination = path.join(dir, `${name}_${archive.index + 1n}${ext}`);
      // Refuse collisions instead of overwriting an existing session
      try {
        fs.lstatSync(destination);
        throw new Error(`Log archive already exists: ${destination}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      fs.renameSync(archive.filePath, destination);
    }
  }

  return fs.openSync(logPath, "ax", 0o640);
}

function createSessionLog(logPath, { maxBytes = 10 * 1024 * 1024, maxFiles = 5 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("Log size limit must be at least 4 bytes");
  let fd = openSessionLog(logPath, { maxFiles });
  let size = 0;
  const rotate = () => {
    fs.closeSync(fd);
    fd = undefined;
    fd = openSessionLog(logPath, { maxFiles });
    size = 0;
  };
  return new Writable({
    write(chunk, encoding, callback) {
      let offset = 0;
      const writeNext = () => {
        try {
          if (offset === chunk.length) { callback(); return; }
          if (size === maxBytes) rotate();
          let end = Math.min(chunk.length, offset + maxBytes - size);
          // Keep UTF-8 code points in the same archive
          while (end < chunk.length && end > offset && (chunk[end] & 0xc0) === 0x80) end -= 1;
          if (end === offset) {
            rotate();
            end = Math.min(chunk.length, offset + maxBytes);
            while (end < chunk.length && end > offset && (chunk[end] & 0xc0) === 0x80) end -= 1;
          }
          fs.write(fd, chunk, offset, end - offset, null, (error, written) => {
            if (error) { callback(error); return; }
            if (!written) { callback(new Error("Log write made no progress")); return; }
            size += written;
            offset += written;
            writeNext();
          });
        } catch (error) { callback(error); }
      };
      writeNext();
    },
    destroy(error, callback) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch (closeError) { error ||= closeError; }
      fd = undefined;
      callback(error);
    },
  });
}

module.exports = { createSessionLog, openSessionLog };
