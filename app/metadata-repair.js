const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { StringDecoder } = require("node:string_decoder");
const { TextDecoder } = require("node:util");
const { parseShoutcastConfig } = require("./shoutcast-config");

const WINDOWS_1252_BYTES = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

const MOJIBAKE_MARKERS = new Set(["Ã", "Â", "Ä", "Å", "Æ", "È", "Ð", "Ñ", "â"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const windows1252Decoder = new TextDecoder("windows-1252");

function mojibakeScore(value) {
  let score = 0;
  for (const character of value) {
    if (MOJIBAKE_MARKERS.has(character)) score += 2;
    if (character === "�") score += 8;
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 && character !== "\t" && character !== "\n" && character !== "\r") {
      score += 4;
    }
  }
  return score;
}

function encodeWindows1252(value) {
  const bytes = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xff) {
      bytes.push(codePoint);
      continue;
    }

    const mappedByte = WINDOWS_1252_BYTES.get(codePoint);
    if (mappedByte === undefined) return null;
    bytes.push(mappedByte);
  }
  return Uint8Array.from(bytes);
}

function repairMojibake(value) {
  if (typeof value !== "string" || value.length === 0) return value;

  let current = value.normalize("NFC");
  for (let pass = 0; pass < 3; pass += 1) {
    const characters = [...current];
    let candidate = "";
    for (let index = 0; index < characters.length; index += 1) {
      const first = encodeWindows1252(characters[index])?.[0];
      const length = first >= 0xc2 && first <= 0xdf ? 2
        : first >= 0xe0 && first <= 0xef ? 3
        : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
      let repaired;
      if (length && index + length <= characters.length) {
        const encoded = characters.slice(index, index + length).join("");
        const bytes = encodeWindows1252(encoded);
        if (bytes) {
          try {
            const decoded = utf8Decoder.decode(bytes);
            if (mojibakeScore(decoded) <= mojibakeScore(encoded) || decoded.codePointAt(0) > 0xff) {
              repaired = decoded;
            }
          } catch {
            // Preserve valid Unicode around independently corrupted sequences
          }
        }
      }
      candidate += repaired ?? characters[index];
      if (repaired !== undefined) index += length - 1;
    }
    candidate = candidate.normalize("NFC");
    if (candidate === current) break;
    current = candidate;
  }
  return current;
}

function readPositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2147483647) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || (net.isIP(host) === 4 && host.startsWith("127."));
}

function isLocalAddress(hostname) {
  if (isLoopback(hostname)) return true;
  const canonical = (address) => {
    const host = address.replace(/^\[|\]$/g, "");
    if (!net.isIP(host)) return "";
    return new URL(`http://${net.isIP(host) === 6 ? `[${host}]` : host}`).hostname;
  };
  const host = canonical(hostname);
  return host !== "" && Object.values(os.networkInterfaces()).flat().some(
    (item) => item && !item.address.includes("%") && canonical(item.address) === host,
  );
}

function metadataBaseUrl(values, port, override) {
  let baseUrl;
  if (override) {
    baseUrl = new URL(override);
  } else {
    let destination = (values.get("destip") || "").trim();
    if (!destination || /^(any|0\.0\.0\.0)$/i.test(destination)) destination = "127.0.0.1";
    if (destination === "::" || destination === "[::]") destination = "[::1]";
    if (net.isIP(destination) === 6) destination = `[${destination}]`;
    baseUrl = new URL(destination.includes("://") ? destination : `http://${destination}`);
    baseUrl.port = String(port);
    baseUrl.pathname = "/";
    baseUrl.search = "";
    baseUrl.hash = "";
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("RADIO_DNAS_URL must use HTTP or HTTPS.");
  }
  if (baseUrl.username || baseUrl.password) {
    throw new Error("DNAS URLs must not contain credentials; use the SHOUTcast admin password settings.");
  }
  if (baseUrl.protocol === "http:" && !isLocalAddress(baseUrl.hostname)) {
    throw new Error(
      `DNAS metadata address ${baseUrl.origin} is not a local interface IP. ` +
        "Use a local IP for destip, or set RADIO_DNAS_URL to an HTTPS administration endpoint.",
    );
  }
  return baseUrl;
}

function findStreamSlot(values, streamId) {
  for (const [key, value] of values) {
    const match = /^streamid_(\d+)$/.exec(key);
    if (match && Number.parseInt(value, 10) === streamId) return Number.parseInt(match[1], 10);
  }
  return streamId;
}

function loadMetadataConfig(serverRoot, environment = process.env, streamIdOverride) {
  const configPath = path.resolve(serverRoot, environment.SC_SERV_CONFIG || "sc_serv.conf");
  const values = parseShoutcastConfig(fs.readFileSync(configPath, "utf8"));
  const streamId = readPositiveInteger(
    streamIdOverride ?? environment.RADIO_STREAM_ID ?? values.get("streamid_1"),
    1,
    "RADIO_STREAM_ID",
  );
  const port = readPositiveInteger(
    environment.RADIO_DNAS_PORT || values.get("portbase"),
    8000,
    "RADIO_DNAS_PORT",
  );
  if (port > 65535) throw new Error("RADIO_DNAS_PORT must not exceed 65535.");

  const baseUrl = metadataBaseUrl(values, port, environment.RADIO_DNAS_URL);

  const intervalMs = readPositiveInteger(
    environment.RADIO_METADATA_INTERVAL_MS,
    2000,
    "RADIO_METADATA_INTERVAL_MS",
  );
  if (intervalMs < 250) throw new Error("RADIO_METADATA_INTERVAL_MS must be at least 250.");

  const streamSlot = findStreamSlot(values, streamId);
  const passwords = [...new Set([
    environment.RADIO_ADMIN_PASSWORD,
    values.get(`streamadminpassword_${streamSlot}`),
    values.get("adminpassword"),
  ].filter(Boolean))];

  return {
    baseUrl,
    enabled: environment.RADIO_METADATA_REPAIR === "1",
    intervalMs,
    password: passwords[0] || "",
    passwords,
    streamId,
  };
}

function normalisePublishedTitle(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/g, " ")
    .replace(/\s+/g, " ").trim().normalize("NFC");
}

function isPublishableTitle(value) {
  const title = normalisePublishedTitle(value);
  return title !== "" && title !== "-" && title !== "." && !/^unknown track$/i.test(title);
}

function extractMetadataEvent(line) {
  const match = String(line).match(/^\[RADIO_METADATA:([1-9]\d*)\] (.+)$/);
  if (!match) return null;
  const streamId = Number(match[1]);
  if (!Number.isInteger(streamId) || streamId > 2147483647) return null;
  let value;
  try { value = JSON.parse(match[2]); } catch { return null; }
  if (typeof value !== "string") return null;
  const title = normalisePublishedTitle(value);
  return isPublishableTitle(title) ? { streamId, title } : null;
}

function createMetadataLogParser(onTitle) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  const maxLine = 65536;

  const processText = (text, flush = false) => {
    if (discarding) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1);
      discarding = false;
    }
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = flush ? "" : lines.pop();
    for (const line of lines) {
      if (line.length > maxLine) continue;
      const event = extractMetadataEvent(line);
      if (event) onTitle(event.title, event.streamId);
    }
    if (pending.length > maxLine) { pending = ""; discarding = true; }
  };

  return {
    write(chunk) {
      processText(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    },
    end() {
      processText(decoder.end(), true);
    },
  };
}

function decodeResponse(bytes) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return windows1252Decoder.decode(bytes);
  }
}

function createRequestSignal(timeoutMs = 5000) {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

async function readResponse(response) {
  const maximum = 65536;
  if (Number(response.headers?.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("DNAS response exceeds the metadata size limit.");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new Error("DNAS response exceeds the metadata size limit.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("DNAS response exceeds the metadata size limit.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

async function fetchCurrentTitle(config, fetchImplementation = globalThis.fetch) {
  const url = new URL("/currentsong", config.baseUrl);
  url.searchParams.set("sid", String(config.streamId));
  const response = await fetchImplementation(url, {
    headers: { Accept: "text/plain; charset=utf-8" },
    redirect: "error",
    signal: createRequestSignal(),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DNAS current-song request returned HTTP ${response.status}.`);
  }

  const bytes = await readResponse(response);
  const title = decodeResponse(bytes).trim();
  if (title.startsWith("<") && /<html|<!doctype/i.test(title)) {
    throw new Error("DNAS current-song request returned an HTML page instead of a title.");
  }
  return title;
}

async function updateTitle(config, title, fetchImplementation = globalThis.fetch) {
  const url = new URL("/admin.cgi", config.baseUrl);
  url.searchParams.set("sid", String(config.streamId));
  url.searchParams.set("pass", config.password);
  url.searchParams.set("mode", "updinfo");
  url.searchParams.set("song", title);

  const response = await fetchImplementation(url, {
    headers: { Accept: "text/plain, text/html" },
    redirect: "error",
    signal: createRequestSignal(),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DNAS metadata update returned HTTP ${response.status}.`);
  }

  const body = decodeResponse(await readResponse(response));
  if (/invalid password|(?:title|metadata) update rejected|stream does not exist|unauthori[sz]ed/i.test(body)) {
    throw new Error("DNAS rejected the metadata update.");
  }
}

function startMetadataPublisher({
  serverRoot,
  streamIds,
  logger = console,
  fetchImplementation = globalThis.fetch,
  environment = process.env,
  retryDelaysMs = [1500, 4000, 8000],
  reconcileIntervalMs,
}) {
  const uniqueStreamIds = [...new Set(streamIds)];
  const targets = uniqueStreamIds.map((streamId) => ({
    ...loadMetadataConfig(serverRoot, environment, streamId),
    lastPublishedTitle: "",
    publishing: false,
    lastError: "",
    lastErrorAt: 0,
  }));
  const activeTargets = targets.filter((target) => {
    if (target.passwords.length > 0) return true;
    logger.warn(
      `[METADATA] Stream #${target.streamId} has no stream administrator or administrator password.`,
    );
    return false;
  });
  const delays = retryDelaysMs.map((value) => readPositiveInteger(
    value,
    1,
    "metadata retry delay",
  ));
  const intervalMs = reconcileIntervalMs ?? targets[0]?.intervalMs ?? 2000;

  let stopped = false;
  let currentTitle = "";
  let generation = 0;
  let reconciling = false;
  const timers = new Set();

  const publishWithAvailablePassword = async (target, title, isCurrent) => {
    let lastError;
    for (const password of target.passwords) {
      if (!isCurrent()) return false;
      try {
        await updateTitle({ ...target, password }, title, fetchImplementation);
        if (!isCurrent()) return false;
        const confirmedTitle = normalisePublishedTitle(
          await fetchCurrentTitle(target, fetchImplementation),
        );
        if (!isCurrent()) return false;
        if (confirmedTitle !== title) {
          throw new Error("DNAS did not confirm the published title.");
        }
        target.password = password;
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("No SHOUTcast administrator password is configured.");
  };

  const attemptPublish = async (target, title, expectedGeneration, reportFailure) => {
    const isCurrent = () => !stopped && generation === expectedGeneration && currentTitle === title;
    if (
      !isCurrent() ||
      target.lastPublishedTitle === title ||
      target.publishing
    ) {
      return;
    }

    target.publishing = true;
    try {
      const confirmed = await publishWithAvailablePassword(target, title, isCurrent);
      if (confirmed && isCurrent()) {
        target.lastPublishedTitle = title;
        target.lastError = "";
        logger.log(`[METADATA] Published to SHOUTcast stream #${target.streamId}: ${title}`);
      }
    } catch (error) {
      const now = Date.now();
      const code = error.cause?.code;
      const detail = typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
        ? `${error.message} (${code})` : error.message;
      if (
        reportFailure && isCurrent() &&
        (detail !== target.lastError || now - target.lastErrorAt >= 60000)
      ) {
        logger.warn(`[METADATA] Stream #${target.streamId} via ${target.baseUrl.origin}: ${detail}`);
        target.lastError = detail;
        target.lastErrorAt = now;
      }
    } finally {
      target.publishing = false;
      if (!stopped && generation !== expectedGeneration) {
        void attemptPublish(target, currentTitle, generation, false);
      }
    }
  };

  const schedulePublish = (target, title, expectedGeneration) => {
    delays.forEach((delayMs, index) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void attemptPublish(
          target,
          title,
          expectedGeneration,
          index === delays.length - 1,
        );
      }, delayMs);
      timer.unref();
      timers.add(timer);
    });
  };

  const publish = (value) => {
    const title = normalisePublishedTitle(environment.RADIO_METADATA_REPAIR === "1" ? repairMojibake(value) : value);
    if (!isPublishableTitle(title) || stopped) return false;
    if (title === currentTitle) return activeTargets.length > 0;

    currentTitle = title;
    generation += 1;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const target of activeTargets) {
      target.lastPublishedTitle = "";
      void attemptPublish(target, title, generation, false);
      schedulePublish(target, title, generation);
    }
    return activeTargets.length > 0;
  };

  const reconcile = async () => {
    if (stopped || reconciling || !currentTitle) return;
    reconciling = true;
    const expectedGeneration = generation;
    const title = currentTitle;
    const isCurrent = () => !stopped && generation === expectedGeneration && currentTitle === title;
    try {
      await Promise.all(activeTargets.map(async (target) => {
        if (!isCurrent() || target.publishing) return;
        let remoteTitle = "";
        try {
          remoteTitle = normalisePublishedTitle(
            await fetchCurrentTitle(target, fetchImplementation),
          );
        } catch {
          // A restarted stream may reject reads until its title is restored
        }
        if (!isCurrent() || target.publishing) return;
        if (remoteTitle === title) {
          target.lastPublishedTitle = title;
          target.lastError = "";
        } else {
          target.lastPublishedTitle = "";
          await attemptPublish(target, title, expectedGeneration, true);
        }
      }));
    } finally {
      reconciling = false;
    }
  };

  if (activeTargets.length > 0) {
    logger.log(
      `[METADATA] SHOUTcast publishing is active for stream${activeTargets.length === 1 ? "" : "s"} ` +
        `${activeTargets.map((target) => `#${target.streamId} via ${target.baseUrl.origin}`).join(", ")}.`,
    );
  }
  const interval = setInterval(reconcile, intervalMs);
  interval.unref();

  return {
    publish,
    stop() {
      stopped = true;
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

async function repairOnce(config, fetchImplementation = globalThis.fetch, { isCurrent = () => true } = {}) {
  const title = await fetchCurrentTitle(config, fetchImplementation);
  const repairedTitle = repairMojibake(title);
  if (!isCurrent() || !title || repairedTitle === title) {
    return { changed: false, title };
  }

  await updateTitle(config, repairedTitle, fetchImplementation);
  return { changed: true, title: repairedTitle };
}

function startMetadataRepair({ serverRoot, logger = console, fetchImplementation = globalThis.fetch, environment = process.env }) {
  const config = loadMetadataConfig(serverRoot, environment);
  if (!config.enabled) return { stop() {} };
  if (!config.password) {
    logger.warn("[METADATA] Unicode repair is disabled because no DNAS admin password is configured.");
    return { stop() {} };
  }

  let stopped = false;
  let running = false;
  let lastError = "";
  let lastErrorAt = 0;
  const startupGraceUntil = Date.now() + Math.max(10000, config.intervalMs * 5);

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await repairOnce(config, fetchImplementation, { isCurrent: () => !stopped });
      if (stopped) return;
      if (result.changed) logger.log(`[METADATA] Corrected title encoding: ${result.title}`);
      lastError = "";
    } catch (error) {
      if (stopped) return;
      const now = Date.now();
      if (
        now >= startupGraceUntil &&
        (error.message !== lastError || now - lastErrorAt >= 60000)
      ) {
        logger.warn(`[METADATA] ${error.message}`);
        lastError = error.message;
        lastErrorAt = now;
      }
    } finally {
      running = false;
    }
  };

  logger.log(`[METADATA] Unicode repair is active for stream #${config.streamId}.`);
  const initialTimer = setTimeout(tick, 2000);
  const interval = setInterval(tick, config.intervalMs);
  initialTimer.unref();
  interval.unref();

  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
}

module.exports = {
  createMetadataLogParser,
  decodeResponse,
  extractMetadataEvent,
  fetchCurrentTitle,
  isPublishableTitle,
  loadMetadataConfig,
  normalisePublishedTitle,
  parseShoutcastConfig,
  repairMojibake,
  repairOnce,
  startMetadataPublisher,
  startMetadataRepair,
  updateTitle,
};
