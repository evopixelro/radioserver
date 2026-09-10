const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { StringDecoder } = require("node:string_decoder");
const { setTimeout: delay } = require("node:timers/promises");

const CHUNK_BYTES = 64 * 1024;
const HISTORY_LINES = 50;

class LogTail {
  constructor(filePath) {
    this.filePath = filePath;
    this.initial = true;
    this.reset();
  }

  reset() {
    this.identity = null;
    this.position = 0;
    this.anchor = Buffer.alloc(0);
    this.decoder = new StringDecoder("utf8");
  }

  read() {
    let fd;
    try {
      // Do not block on pipes or hold a file open across log rotation
      fd = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw new Error(`Console requires a regular log file: ${this.filePath}`);
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Log file is too large: ${this.filePath}`);
      const size = Number(stat.size);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
      let replaced = this.identity !== identity || size < this.position;
      if (!replaced && this.anchor.length) {
        const anchor = Buffer.alloc(this.anchor.length);
        const count = fs.readSync(fd, anchor, 0, anchor.length, this.position - anchor.length);
        replaced = count !== anchor.length || !anchor.equals(this.anchor);
      }
      if (replaced) this.reset();
      this.identity = identity;

      const history = this.initial;
      if (history) this.position = Math.max(0, size - CHUNK_BYTES);
      const start = this.position;
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, size - start)));
      const count = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, start) : 0;
      const bytes = buffer.subarray(0, count);
      this.position += count;
      this.anchor = Buffer.concat([this.anchor, bytes]).subarray(-32);
      this.initial = false;

      let content = bytes;
      if (history && start > 0) {
        // Discard the first partial line, including a possible partial UTF-8 character
        const newline = content.indexOf(10);
        if (newline >= 0) content = content.subarray(newline + 1);
        else {
          let boundary = 0;
          while (boundary < content.length && (content[boundary] & 0xc0) === 0x80) boundary += 1;
          content = content.subarray(boundary);
        }
      }
      const text = this.decoder.write(content);
      if (!history) return text;
      const lines = text.split("\n");
      return lines.slice(-(text.endsWith("\n") ? HISTORY_LINES + 1 : HISTORY_LINES)).join("\n");
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) {
        this.reset();
        return "";
      }
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

async function followLogs(filePaths, { label, output = process.stdout, intervalMs = 500, signal: externalSignal } = {}) {
  const tails = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].map((filePath) => new LogTail(filePath));
  if (!tails.length) throw new Error("No log files were configured for this console");
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const stop = () => controller.abort();
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  let outputError;
  const failed = (error) => { outputError = error; stop(); };
  for (const name of signals) process.on(name, stop);
  output.on("error", failed);
  output.on("close", stop);

  const write = async (text) => {
    if (signal.aborted) return;
    if (output.destroyed || !output.writable) { stop(); return; }
    if (!output.write(text)) await once(output, "drain", { signal });
  };
  let previousFile;
  try {
    await write(`${label} console (read-only). Press CTRL+C to close console without stopping ${label}.\n`);
    await write(`Showing up to ${HISTORY_LINES} recent lines per log (maximum 64 KiB), then following live output.\n`);
    await write(`Following: ${tails.map((tail) => tail.filePath).join(", ")}\nMissing log files will be followed when they appear.\n`);
    while (!signal.aborted) {
      for (const tail of tails) {
        if (signal.aborted) break;
        const text = tail.read();
        if (!text) continue;
        if (tails.length > 1 && previousFile !== tail.filePath) await write(`\n==> ${tail.filePath} <==\n`);
        previousFile = tail.filePath;
        await write(text);
      }
      await delay(intervalMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    for (const name of signals) process.removeListener(name, stop);
    output.removeListener("error", failed);
    output.removeListener("close", stop);
  }
  if (outputError && !["EPIPE", "EIO"].includes(outputError.code)) throw outputError;
}

module.exports = { LogTail, followLogs };
