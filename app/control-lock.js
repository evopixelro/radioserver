const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const processState = require("./process-state");

const operations = new AsyncLocalStorage();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ENTRY = /^\d+-[a-f0-9-]{36}\.json$/;
const retrySignal = new Int32Array(new SharedArrayBuffer(4));

function retryFileOperation(action) {
  const deadline = performance.now() + 1000;
  for (;;) {
    try { return action(); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || performance.now() >= deadline) throw error;
      // Windows can briefly deny replacement while another process reads the record
      Atomics.wait(retrySignal, 0, 0, 20);
    }
  }
}

function readRecord(file) {
  try {
    return retryFileOperation(() => {
      let fd;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink > 1 || stat.size > 16384) throw new Error("not a regular, bounded lock record");
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        // Atomic replacement can unlink an open snapshot while it is being read
        if (!opened.isFile() || opened.nlink > 1 || opened.size > 16384) throw new Error("invalid open lock record");
        return JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read controller lock record ${file}: ${error.message}`);
  }
}

function validRecord(record) {
  return record?.version === 2 && Number.isSafeInteger(record.pid) && record.pid > 1 &&
    typeof record.fingerprint === "string" && record.fingerprint.length > 0 &&
    typeof record.nonce === "string" && UUID.test(record.nonce) &&
    typeof record.order === "string" && UUID.test(record.order) &&
    typeof record.ticket === "string" && /^(0|[1-9]\d{0,100})$/.test(record.ticket) &&
    ["choosing", "waiting", "holding", "borrowed"].includes(record.phase) &&
    (record.phase === "choosing" ? record.ticket === "0" : record.ticket !== "0") &&
    (record.phase === "borrowed" || record.order === record.nonce) &&
    typeof record.unsafe === "boolean" &&
    typeof record.operation === "string" && /^[\w :_-]{1,80}$/.test(record.operation);
}

function removeRecord(file) {
  try { retryFileOperation(() => fs.unlinkSync(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function publish(file, record) {
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    retryFileOperation(() => fs.renameSync(temporary, file));
  } finally { removeRecord(temporary); }
}

function entryPath(directory, record) {
  return path.join(directory, `${record.pid}-${record.nonce}.json`);
}

function sameOwner(left, right) {
  return left?.pid === right.pid && left?.fingerprint === right.fingerprint && left?.nonce === right.nonce;
}

function precedes(left, right) {
  return BigInt(left.ticket) < BigInt(right.ticket) || (left.ticket === right.ticket && left.order < right.order);
}

// Unique registrations avoid deleting a new owner's lock during concurrent recovery
function snapshot(directory, self, inspect) {
  for (;;) {
    const records = [];
    let changed = false;
    const identities = new Map([[self.pid, { fingerprint: self.fingerprint }]]);
    for (const name of fs.readdirSync(directory)) {
      if (!ENTRY.test(name)) continue;
      const file = path.join(directory, name);
      let record = readRecord(file);
      if (!record) { changed = true; continue; }
      if (!validRecord(record) || file !== entryPath(directory, record)) {
        throw new Error(`Invalid controller registration ${file}. Automatic recovery is unsafe; confirm all controller operations are stopped before removing it.`);
      }
      if (!identities.has(record.pid)) identities.set(record.pid, inspect(record.pid));
      const alive = identities.get(record.pid)?.fingerprint === record.fingerprint;
      if (!alive) {
        // The owner may have entered a spawn window between our read and its exit
        const latest = readRecord(file);
        if (!latest) { changed = true; continue; }
        if (!validRecord(latest) || !sameOwner(latest, record)) throw new Error(`Controller registration changed unexpectedly: ${file}`);
        record = latest;
      }
      if (!alive && !record.unsafe) {
        removeRecord(file);
        removeRecord(`${file}.tmp`);
        changed = true;
      } else records.push({ ...record, alive, file });
    }
    // A child may have registered just before its parent exited
    if (!changed) return records;
  }
}

function ownership(directory, record) {
  if (!sameOwner(readRecord(entryPath(directory, record)), record)) {
    throw new Error("Controller registration changed during the operation; refusing to continue.");
  }
}

function beginChildStartup() {
  const operation = operations.getStore();
  if (!operation) return () => {};
  operation.assertParent();
  operation.update(true);
  // SIGKILL between spawn and PID publication cannot safely identify an orphan
  return () => operation.update(false);
}

async function withControlLock(directory, action, {
  inherited = false, timeoutMs = 0, onWait = () => {}, onRecover = () => {},
  operation = "controller operation", recoverable = true, inspect = processState.inspect,
} = {}) {
  if (!/^[\w :_-]{1,80}$/.test(operation)) throw new Error("Invalid controller operation label");
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  directory = fs.realpathSync(directory);
  const registrations = path.join(directory, "control-locks");
  fs.mkdirSync(registrations, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(registrations).isSymbolicLink()) throw new Error("Controller registrations must not be a symbolic link");
  const lockPath = path.join(directory, "control.lock");
  const identity = inspect(process.pid);
  if (!identity?.fingerprint) throw new Error("Could not identify the controller process.");
  const nonce = crypto.randomUUID();
  const record = { version: 2, pid: process.pid, fingerprint: identity.fingerprint, nonce, order: nonce,
    ticket: "0", phase: "choosing", unsafe: false, operation };
  const file = entryPath(registrations, record);
  const deadline = performance.now() + timeoutMs;
  let waiting = false;
  let ownsLock = false;
  let parent;
  const inheritedNonce = process.env.RADIO_CONTROL_NONCE;
  let previous;
  let entered = false;
  const update = (unsafe) => {
    ownership(registrations, record);
    record.unsafe = unsafe;
    publish(file, record);
  };
  const assertParent = () => {
    if (!parent) return;
    if (!sameOwner(readRecord(lockPath), parent) || !sameOwner(readRecord(entryPath(registrations, parent)), parent) ||
        inspect(parent.pid)?.fingerprint !== parent.fingerprint) {
      throw new Error("Startup controller disconnected before the engine was ready.");
    }
  };
  const wait = async (owner, reason = "") => {
    const displayed = Number.isSafeInteger(owner?.pid) && owner.pid > 1 ? {
      pid: owner.pid, operation: /^[\w :_-]{1,80}$/.test(owner.operation || "") ? owner.operation : "Controller operation",
    } : null;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const description = displayed ? ` Current operation: ${displayed.operation} (PID ${displayed.pid}).` : "";
      throw new Error(`Another controller operation holds ${lockPath}. ` +
        (waiting ? `It did not finish within ${timeoutMs / 1000} seconds.` : "Retry after it finishes.") +
        description + (reason ? ` ${reason}` : "") +
        " If it was interrupted, confirm both services and all install/start/stop commands are stopped before removing this lock file or its control-locks registration.");
    }
    if (!waiting) { waiting = true; onWait(displayed); }
    await delay(Math.min(250, remaining));
  };
  try {
    if (inherited && inheritedNonce) {
      parent = readRecord(lockPath);
      if (!process.connected || !validRecord(parent) || parent.nonce !== inheritedNonce || parent.pid !== process.ppid || parent.phase !== "holding") {
        throw new Error("Startup controller lock is missing or does not match this supervisor.");
      }
      Object.assign(record, { ticket: parent.ticket, order: parent.order, phase: "borrowed" });
      publish(file, record);
      // Publish before checking the parent so recovery cannot miss an active delegate
      assertParent();
    } else {
      publish(file, record);
      const peers = snapshot(registrations, record, inspect);
      record.ticket = (peers.reduce((maximum, peer) => BigInt(peer.ticket) > maximum ? BigInt(peer.ticket) : maximum, 0n) + 1n).toString();
      record.phase = "waiting";
      publish(file, record);
      for (;;) {
        const blocker = snapshot(registrations, record, inspect).find((peer) => peer.nonce !== nonce &&
          (peer.phase === "choosing" || precedes(peer, record)));
        if (blocker) {
          await wait(blocker, !blocker.alive ? `Interrupted startup or external tool needs manual verification: ${blocker.file}.` : "");
          continue;
        }
        record.phase = "holding";
        publish(file, record);
        let fd;
        try { fd = retryFileOperation(() => fs.openSync(lockPath, "wx", 0o600)); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          let owner;
          try { owner = readRecord(lockPath); } catch {}
          if (!owner && !fs.existsSync(lockPath)) continue;
          const valid = validRecord(owner) && owner.phase === "holding";
          if (valid && inspect(owner.pid)?.fingerprint !== owner.fingerprint) {
            // Every new controller joins the queue before replacing the shared record
            ownership(registrations, record);
            const current = readRecord(lockPath);
            if (!sameOwner(current, owner)) continue;
            removeRecord(lockPath);
            onRecover(owner);
            continue;
          }
          await wait(owner, valid ? "" : "Lock metadata is incomplete or from an untracked operation; automatic recovery is unavailable.");
          continue;
        }
        try { fs.writeFileSync(fd, JSON.stringify(record)); ownsLock = true; }
        finally { fs.closeSync(fd); }
        break;
      }
    }
    previous = process.env.RADIO_CONTROL_NONCE;
    entered = true;
    process.env.RADIO_CONTROL_NONCE = nonce;
    if (!recoverable) update(true);
    try {
      const result = await operations.run({ update, assertParent }, action);
      if (recoverable && record.unsafe) throw new Error("Controller operation ended without confirming child startup or shutdown.");
      return result;
    } finally {
      if (!recoverable) update(false);
    }
  } finally {
    if (entered) {
      if (previous === undefined) delete process.env.RADIO_CONTROL_NONCE;
      else process.env.RADIO_CONTROL_NONCE = previous;
    }
    // Keep uncertain child/tool state fenced off until an administrator checks it
    if (!record.unsafe) {
      if (ownsLock && sameOwner(readRecord(lockPath), record)) removeRecord(lockPath);
      if (sameOwner(readRecord(file), record)) removeRecord(file);
    }
  }
}

module.exports = { beginChildStartup, withControlLock };
