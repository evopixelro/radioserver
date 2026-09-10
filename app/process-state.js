const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function inspect(pid, includeCommand = false, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (["Z", "X"].includes(fields[0])) return null;
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return { fingerprint: `${boot}:${fields[19]}`, ...(includeCommand ? {
        command: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
        cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
      } : {}) };
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) return null;
      throw error;
    }
  }
  const options = { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
  if (platform === "win32") {
    const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }; try { $created = $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { if ($p.HasExited) { exit 0 }; throw }; $c = ''; ${includeCommand ? `try { $c = (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine } catch {}` : ""}; [pscustomobject]@{ created = $created; command = $c; executable = $p.Path } | ConvertTo-Json -Compress`], options);
    if (result.error || result.status !== 0) throw new Error("Could not verify Windows process creation time");
    if (!result.stdout.trim()) return null;
    const value = JSON.parse(result.stdout);
    return { fingerprint: value.created, command: value.command || "", executable: value.executable };
  }
  const result = run("ps", ["-ww", "-p", String(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="], { ...options, env: { ...process.env, LC_ALL: "C" } });
  if (result.error) throw new Error(`Could not verify process identity: ${result.error.message}`);
  const output = String(result.stdout || "").trim();
  const diagnostic = String(result.stderr || "").trim();
  // BSD ps exits with status 1 when no selected process remains
  if ([0, 1].includes(result.status) && !output && !diagnostic) return null;
  if (result.status !== 0 || diagnostic) throw new Error(`Could not verify process identity with ps: ${diagnostic || `exit status ${result.status}`}`);
  const fields = output.match(/^(\S+)\s+([\s\S]+)$/);
  if (fields && /^[ZX]/.test(fields[1])) return null;
  const match = fields?.[2].match(/^(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  if (!match) throw new Error("Could not read process creation time from ps");
  return { fingerprint: match[1], command: match[2] };
}

function owner(config, kind) {
  return `${kind}:${path.resolve(kind === "autodj" ? path.join(config.serverRoot, "autodj.js") : config.binaryPath)}`;
}

function commandMatches(info, config, kind) {
  const target = path.resolve(kind === "autodj" ? path.join(config.serverRoot, "autodj.js") : config.binaryPath);
  if (!info.command && info.executable) {
    if (kind === "autodj" && path.resolve(info.executable).toLowerCase() === process.execPath.toLowerCase()) {
      throw new Error("Cannot verify an old AutoDJ PID record without its command line. Stop the old supervisor manually before replacing its PID file");
    }
    return kind === "shoutcast" && path.resolve(info.executable).toLowerCase() === target.toLowerCase();
  }
  if (Array.isArray(info.command)) {
    const argument = info.command[kind === "autodj" ? 1 : 0];
    return Boolean(argument && (path.isAbsolute(argument) || info.cwd) && path.resolve(info.cwd || ".", argument) === target);
  }
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])${escaped}(?:$|[\\s"'])`, process.platform === "win32" ? "i" : "").test(info.command);
}

function read(config) {
  try {
    const text = fs.readFileSync(config.pidPath, "utf8").trim();
    const record = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
    return record && Number.isSafeInteger(record.pid) && record.pid > 1 ? record : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function remove(config, pid) {
  if (pid !== undefined && read(config)?.pid !== pid) return;
  try { fs.unlinkSync(config.pidPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function save(config, pid, kind, { childPid } = {}) {
  const info = module.exports.inspect(pid);
  if (!info) throw new Error("Process exited before its identity could be recorded");
  const record = { pid, fingerprint: info.fingerprint, owner: owner(config, kind) };
  if (childPid) {
    const child = module.exports.inspect(childPid);
    if (!child) throw new Error("Engine exited before its identity could be recorded");
    record.child = { pid: childPid, fingerprint: child.fingerprint };
  }
  const temporary = `${config.pidPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o640 });
    fs.renameSync(temporary, config.pidPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function status(config, kind) {
  const record = read(config);
  if (!record) return { running: false, pid: null };
  const info = module.exports.inspect(record.pid, !record.fingerprint);
  const assertOwner = () => {
    if (typeof record.owner === "string" && record.owner.startsWith(`${kind}:`) && record.owner !== owner(config, kind)) {
      throw new Error("A running process belongs to a different runtime path. Stop it using its original configuration before changing the executable or platform.");
    }
  };
  if (info && record.fingerprint === info.fingerprint) assertOwner();
  const matches = info && (record.fingerprint
    ? record.fingerprint === info.fingerprint && record.owner === owner(config, kind)
    : commandMatches(info, config, kind));
  if (!matches) {
    if (record.child?.fingerprint &&
        module.exports.inspect(record.child.pid)?.fingerprint === record.child.fingerprint) {
      assertOwner();
      if (record.owner === owner(config, kind)) return { running: true, pid: record.child.pid };
    }
    return { running: false, pid: null };
  }
  return { running: true, pid: record.pid };
}

async function stop(config, kind, { timeoutMs = 10000, forceTimeoutMs = 2000 } = {}) {
  const initial = status(config, kind);
  if (!initial.running) { remove(config); return false; }
  const record = read(config);
  const initialInfo = module.exports.inspect(initial.pid, !record?.fingerprint);
  const initialIdentity = record?.fingerprint
    ? initial.pid === record.pid ? record.fingerprint : record.child?.fingerprint
    : initialInfo && commandMatches(initialInfo, config, kind) ? initialInfo.fingerprint : null;
  const childIsOurs = () => record?.child && module.exports.inspect(record.child.pid)?.fingerprint === record.child.fingerprint;
  const signalChild = (value) => {
    if (!childIsOurs()) return;
    try { process.kill(record.child.pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const stillOurs = () => {
    return Boolean(initialIdentity && module.exports.inspect(initial.pid)?.fingerprint === initialIdentity);
  };
  const signal = (value) => {
    if (!stillOurs()) return;
    try {
      process.kill(initial.pid, value);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const wait = async (timeout) => {
    const deadline = Date.now() + timeout;
    while (stillOurs() || childIsOurs()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return true;
  };
  if (process.platform === "win32") signalChild("SIGTERM");
  signal("SIGTERM");
  if (!(await wait(timeoutMs))) {
    signalChild("SIGKILL");
    signal("SIGKILL");
    if (!(await wait(forceTimeoutMs))) {
      fs.writeFileSync(config.pidPath, `${JSON.stringify(record)}\n`, { mode: 0o640 });
      throw new Error(`Process ${initial.pid} did not stop; its PID record was retained`);
    }
  }
  remove(config, record?.pid || initial.pid);
  return true;
}

function waitForSpawn(child, graceMs = 500) {
  return new Promise((resolve, reject) => {
    let timer;
    const fail = (error) => { clearTimeout(timer); cleanup(); reject(error); };
    const exited = (code, signal) => fail(new Error(`Process exited during startup (${signal || code}); check its log`));
    const started = () => { timer = setTimeout(() => { cleanup(); resolve(child.pid); }, graceMs); };
    const cleanup = () => { child.removeListener("error", fail); child.removeListener("exit", exited); child.removeListener("spawn", started); };
    child.once("error", fail);
    child.once("exit", exited);
    child.once("spawn", started);
  });
}

function waitForReady(child, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("Timed out waiting for the service supervisor")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); child.removeListener("error", fail); child.removeListener("exit", exited); child.removeListener("message", ready); };
    const fail = (error) => { cleanup(); reject(error); };
    const exited = (code, signal) => fail(new Error(`Supervisor exited during startup (${signal || code})`));
    const ready = (message) => {
      if (message?.type === "radioserver:error") { fail(new Error(String(message.message))); return; }
      if (message?.type === "radioserver:ready") { cleanup(); resolve(child.pid); }
    };
    child.once("error", fail);
    child.once("exit", exited);
    child.on("message", ready);
  });
}

function waitForExit(child, timeoutMs = 15000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const closed = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener("close", closed);
      reject(new Error(`Supervisor ${child.pid} did not exit during startup cleanup`));
    }, timeoutMs);
    child.once("close", closed);
  });
}

function forwardSignals(child, { timeoutMs = 10000, onOutputError } = {}) {
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  let stopping = false;
  let closed = false;
  let outputFailed = false;
  let timer;
  const running = () => child.exitCode === null && child.signalCode === null;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const shutdown = (signal = "SIGTERM") => {
    if (stopping || closed || !running()) return;
    stopping = true;
    timer = setTimeout(() => {
      if (running()) child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    // A terminal hangup must stop the engine; SHOUTcast treats SIGHUP as log rotation
    child.kill(signal === "SIGHUP" ? "SIGTERM" : signal);
  };
  const handlers = signals.map((signal) => [signal, () => shutdown(signal)]);
  const outputError = (error) => {
    if (outputFailed || closed) return;
    outputFailed = true;
    try { onOutputError(error); } finally { shutdown(); }
  };
  const destinations = onOutputError ? [process.stdout, process.stderr] : [];
  for (const stream of destinations) stream.on("error", outputError);
  // Keep handlers until close so repeated signals cannot orphan the engine
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.once("exit", clearTimer);
  child.once("close", () => {
    closed = true;
    clearTimer();
    child.removeListener("exit", clearTimer);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    for (const stream of destinations) stream.removeListener("error", outputError);
  });
  return shutdown;
}

module.exports = { commandMatches, forwardSignals, inspect, read, remove, save, status, stop, waitForSpawn, waitForReady, waitForExit };
