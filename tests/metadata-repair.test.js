const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const http = require("node:http");
const { once } = require("node:events");

const {
  createMetadataLogParser,
  extractMetadataEvent,
  loadMetadataConfig,
  parseShoutcastConfig,
  repairMojibake,
  repairOnce,
  startMetadataPublisher,
  startMetadataRepair,
} = require("../app/metadata-repair");

const windows1252Decoder = new TextDecoder("windows-1252");

test("stopping Unicode repair prevents an in-flight lookup from publishing a stale title", async (context) => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-repair-stop-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(serverRoot, "sc_serv.conf"), "PortBase=8000\nadminpassword=test-secret\n");
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolveLookup;
  const pending = new Promise((resolve) => { resolveLookup = resolve; });
  const requests = [];
  const messages = [];
  const repair = startMetadataRepair({
    serverRoot,
    environment: { RADIO_METADATA_REPAIR: "1" },
    logger: { log: (message) => messages.push(message), warn: (message) => messages.push(message) },
    fetchImplementation: async (url) => {
      requests.push(new URL(url).pathname);
      return requests.length === 1 ? pending : new Response("OK");
    },
  });
  context.after(() => repair.stop());
  context.mock.timers.tick(2000);
  assert.deepEqual(requests, ["/currentsong"]);
  repair.stop();
  const messageCount = messages.length;
  resolveLookup(new Response("CÃ¢ntec È™i ÐŸÑ€Ð¸Ð²ÐµÑ‚"));
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(60000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["/currentsong"]);
  assert.equal(messages.length, messageCount);
});

function corruptUtf8AsWindows1252(value) {
  return windows1252Decoder.decode(Buffer.from(value, "utf8"));
}

function publisherFixture(context, fetchImplementation, streamIds = [1], environment = {}) {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-reconnect-test-"));
  fs.writeFileSync(path.join(serverRoot, "sc_serv.conf"), [
    "PortBase=8000", "adminpassword=global-secret",
    ...streamIds.flatMap((id) => [`streamid_${id}=${id}`, `streamadminpassword_${id}=stream-secret`]),
    "",
  ].join("\n"));
  let reconcile;
  context.mock.method(globalThis, "setInterval", (callback) => {
    reconcile = callback;
    return { unref() {} };
  });
  const messages = [];
  const warnings = [];
  const publisher = startMetadataPublisher({
    serverRoot, streamIds, environment, fetchImplementation,
    retryDelaysMs: [],
    logger: { log: (line) => messages.push(line), warn: (line) => warnings.push(line) },
  });
  context.after(() => {
    publisher.stop();
    fs.rmSync(serverRoot, { recursive: true, force: true });
  });
  return { publisher, reconcile, messages, warnings };
}

const flushRequests = () => new Promise((resolve) => setImmediate(resolve));

for (const repair of [undefined, "0", "1"]) {
  test(`title confirmation stays stable with encoding repair ${repair ?? "unset"}`, async (context) => {
    const source = "JoÃ£o — È™i";
    const expected = repair === "1" ? "João — și" : source;
    let remote = "";
    let updates = 0;
    const fixture = publisherFixture(context, async (url) => {
      if (url.pathname === "/admin.cgi") { remote = url.searchParams.get("song"); updates += 1; return new Response("Metadata updated"); }
      return new Response(remote);
    }, [1], { RADIO_METADATA_REPAIR: repair });
    fixture.publisher.publish(source);
    await flushRequests();
    for (let index = 0; index < 4; index += 1) await fixture.reconcile();
    assert.equal(remote, expected);
    assert.equal(updates, 1);
    assert.equal(fixture.warnings.length, 0);
    assert.equal(fixture.messages.filter((message) => message.includes("Published to SHOUTcast")).length, 1);
    // Restore the same exact title after a DNAS restart
    remote = "";
    await fixture.reconcile();
    assert.equal(remote, expected);
    assert.equal(updates, 2);
  });
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("repairs Romanian UTF-8 text decoded as Windows-1252", () => {
  assert.equal(repairMojibake("CÃ¢ntec romÃ¢nesc È™i È›arÄƒ"), "Cântec românesc și țară");
});

test("repairs Cyrillic UTF-8 text decoded as Windows-1252", () => {
  assert.equal(repairMojibake("ÐŸÑ€Ð¸Ð²ÐµÑ‚ Ð¼Ð¸Ñ€"), "Привет мир");
});

test("repairs UTF-8 mojibake for international scripts and emoji", () => {
  const titles = [
    "Ελληνικά",
    "مرحبا بالعالم",
    "你好世界",
    "日本語の曲",
    "한국어 노래",
    "Muzică 🎵 — Radio 📻",
  ];

  for (const title of titles) {
    assert.equal(repairMojibake(title), title);
    assert.equal(repairMojibake(corruptUtf8AsWindows1252(title)), title);
  }
});

test("leaves valid Unicode unchanged", () => {
  assert.equal(repairMojibake("Ștefan cântă – Привет мир"), "Ștefan cântă – Привет мир");
});

test("repairs mixed encoding without changing intact Unicode or punctuation", () => {
  const title = "Ștefan — JoÃ£o / È™i 🎵 Привет";
  const expected = "Ștefan — João / și 🎵 Привет";
  assert.equal(repairMojibake(title), expected);
  assert.equal(repairMojibake(expected), expected);
});

test("repairs repeated encoding and isolated Romanian circumflexes", () => {
  for (const title of ["â", "Cântec și țară", "日本語 🎵"]) {
    const once = corruptUtf8AsWindows1252(title);
    assert.equal(repairMojibake(once), title);
    assert.equal(repairMojibake(corruptUtf8AsWindows1252(once)), title);
  }
});

test("does not consume valid characters after an incomplete corrupt sequence", () => {
  for (const title of ["Ã", "Ã! Ștefan", "È — Привет", "Björk / bülow / La Câlin", "Ângela", "éñ"]) {
    assert.equal(repairMojibake(title), title);
  }
});

test("does not guess characters after irreversible replacement", () => {
  assert.equal(repairMojibake("C�ntec ? necunoscut"), "C�ntec ? necunoscut");
});

test("extracts only explicitly addressed, valid metadata events", () => {
  assert.deepEqual(extractMetadataEvent('[RADIO_METADATA:12] "Știință — Радио"'), {
    streamId: 12, title: "Știință — Радио",
  });
  for (const line of [
    '[RADIO_METADATA:1] "Unknown track"',
    '[RADIO_METADATA:0] "Title"',
    '[RADIO_METADATA:2147483648] "Title"',
    '[RADIO_METADATA:1] {"title":"Title"}',
    '[RADIO_METADATA:1] null',
    '[RADIO_METADATA:1] unquoted title',
    '[RADIO_METADATA] "Title"',
    '[decoder:3] [RADIO_METADATA:1] "Title"',
  ]) assert.equal(extractMetadataEvent(line), null, line);
});

test("parses split UTF-8 Liquidsoap log chunks without corrupting Unicode", () => {
  const titles = [];
  const parser = createMetadataLogParser((title, streamId) => titles.push({ title, streamId }));
  const message = Buffer.from('[RADIO_METADATA:2] "Știință — Радио"\n', "utf8");
  const splitAt = message.indexOf(Buffer.from("Ș", "utf8")) + 1;

  parser.write(message.subarray(0, splitAt));
  parser.write(message.subarray(splitAt));
  parser.end();

  assert.deepEqual(titles, [{ title: "Știință — Радио", streamId: 2 }]);
});

test("metadata framing cannot turn newlines or marker text inside a title into another stream event", () => {
  const events = [];
  const parser = createMetadataLogParser((title, streamId) => events.push({ title, streamId }));
  const title = 'Și "tu"\\\n[RADIO_METADATA:2] "Injected title"';
  parser.write(`[RADIO_METADATA:1] ${JSON.stringify(title)}\n`);
  parser.write('[RADIO_METADATA:2] "Музыка"');
  parser.end();
  assert.deepEqual(events, [
    { title: 'Și "tu"\\ [RADIO_METADATA:2] "Injected title"', streamId: 1 },
    { title: "Музыка", streamId: 2 },
  ]);
});

test("parses active SHOUTcast settings without comments", () => {
  const values = parseShoutcastConfig(`
    ; comment
    PortBase=8000
    streamadminpassword_1=a=b=c
    # another comment
  `);
  assert.equal(values.get("portbase"), "8000");
  assert.equal(values.get("streamadminpassword_1"), "a=b=c");
});

test("keeps HTTP metadata repair opt-in", () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-metadata-"));
  fs.writeFileSync(
    path.join(serverRoot, "sc_serv.conf"),
    "PortBase=8000\nstreamid_1=1\nstreamadminpassword_1=secret\n",
    "utf8",
  );

  try {
    assert.equal(loadMetadataConfig(serverRoot, {}).enabled, false);
    assert.equal(
      loadMetadataConfig(serverRoot, { RADIO_METADATA_REPAIR: "1" }).enabled,
      true,
    );
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

test("metadata uses the DNAS destip binding, not the source or public directory address", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-metadata-address-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  context.mock.method(os, "networkInterfaces", () => ({
    eth0: [{ address: "203.0.113.42" }, { address: "2001:db8:0:0::1" }],
  }));
  const read = (destip, environment = {}) => {
    fs.writeFileSync(path.join(root, "sc_serv.conf"),
      `PortBase=8080\ndestip=${destip}\nsrcip=192.0.2.1\npublicip=radio.example.com\n`);
    return loadMetadataConfig(root, environment).baseUrl.origin;
  };
  assert.equal(read("203.0.113.42"), "http://203.0.113.42:8080");
  assert.equal(read("http://203.0.113.42/"), "http://203.0.113.42:8080");
  assert.equal(read("203.0.113.42", { RADIO_DNAS_PORT: "9000" }), "http://203.0.113.42:9000");
  for (const value of ["", "any", "ANY", "0.0.0.0", "127.0.0.1"]) {
    assert.equal(read(value), "http://127.0.0.1:8080");
  }
  assert.equal(read("127.0.0.2"), "http://127.0.0.2:8080");
  for (const value of ["::", "[::]", "::1", "[::1]"]) {
    assert.equal(read(value), "http://[::1]:8080");
  }
  assert.equal(read("2001:db8::1"), "http://[2001:db8::1]:8080");
  assert.equal(read("203.0.113.42", { RADIO_DNAS_URL: "https://radio.example.com:8443" }),
    "https://radio.example.com:8443");
  assert.equal(read("any", { RADIO_DNAS_URL: "http://203.0.113.42:9001" }), "http://203.0.113.42:9001");
  assert.throws(() => read("192.0.2.50"), /not a local interface IP/);
  assert.throws(() => read("any", { RADIO_DNAS_URL: "http://remote.example.com" }), /HTTPS/);
  assert.throws(() => read("any", { RADIO_DNAS_URL: "ftp://127.0.0.1" }), /HTTP or HTTPS/);
  assert.throws(() => read("any", { RADIO_DNAS_URL: "https://user:secret@example.com" }), /must not contain credentials/);
});

test("sends repaired metadata back to DNAS as UTF-8", async () => {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    assert.equal(options.redirect, "error");
    requests.push(new URL(url));
    if (url.pathname === "/currentsong") {
      return new Response("CÃ¢ntec È™i ÐŸÑ€Ð¸Ð²ÐµÑ‚", { status: 200 });
    }
    return new Response("Metadata updated", { status: 200 });
  };
  const config = {
    baseUrl: new URL("http://127.0.0.1:8000"),
    password: "secret value",
    streamId: 1,
  };

  const result = await repairOnce(config, fetchImplementation);
  assert.deepEqual(result, { changed: true, title: "Cântec și Привет" });
  assert.equal(requests[1].pathname, "/admin.cgi");
  assert.equal(requests[1].searchParams.get("song"), "Cântec și Привет");
  assert.equal(requests[1].searchParams.get("pass"), "secret value");
});

test("publishes exact metadata and retries the SHOUTcast startup race", async () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-metadata-publisher-"));
  fs.writeFileSync(
    path.join(serverRoot, "sc_serv.conf"),
    "PortBase=8000\nstreamid_1=1\nstreamadminpassword_1=secret\n",
    "utf8",
  );
  const requests = [];
  let publishedTitle = "";
  let rejectedFirstUpdate = false;
  const fetchImplementation = async (url) => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.pathname === "/currentsong") {
      return new Response(publishedTitle, { status: 200 });
    }
    if (!rejectedFirstUpdate) {
      rejectedFirstUpdate = true;
      return new Response("Metadata update rejected as the stream does not exist", { status: 200 });
    }
    publishedTitle = requestUrl.searchParams.get("song");
    return new Response("Metadata updated", { status: 200 });
  };
  const logger = { log() {}, warn() {} };
  const publisher = startMetadataPublisher({
    serverRoot,
    streamIds: [1],
    logger,
    fetchImplementation,
    retryDelaysMs: [1, 15],
    reconcileIntervalMs: 60000,
  });

  try {
    assert.equal(publisher.publish("Știință — Радио"), true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const adminRequests = requests.filter(({ pathname }) => pathname === "/admin.cgi");
    assert.equal(adminRequests.length, 2);
    assert.equal(adminRequests[1].searchParams.get("sid"), "1");
    assert.equal(adminRequests[1].searchParams.get("song"), "Știință — Радио");
    assert.equal(adminRequests[1].searchParams.get("pass"), "secret");
    assert.equal(
      requests.filter(({ pathname }) => pathname === "/currentsong").length,
      1,
    );
  } finally {
    publisher.stop();
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

for (const missingStatus of [200, 404, 503]) {
  test(`restores the same title after restart when currentsong returns ${missingStatus}`, async (context) => {
    let remoteTitle = "";
    const updates = [];
    const fixture = publisherFixture(context, async (url) => {
      if (url.pathname === "/currentsong") {
        return new Response(remoteTitle, { status: remoteTitle ? 200 : missingStatus });
      }
      remoteTitle = url.searchParams.get("song");
      updates.push(remoteTitle);
      return new Response("Metadata updated");
    });
    const title = "Știință — Радио 🎵";
    fixture.publisher.publish(title);
    await flushRequests();
    assert.equal(remoteTitle, title);

    remoteTitle = "";
    await fixture.reconcile();
    assert.equal(remoteTitle, title);
    assert.deepEqual(updates, [title, title]);
    await fixture.reconcile();
    assert.equal(updates.length, 2, "Unchanged titles must not be republished");
  });
}

test("logs title confirmation once without redundant detection messages", async (context) => {
  let remoteTitle = "";
  const fixture = publisherFixture(context, async (url) => {
    if (url.pathname === "/currentsong") return new Response(remoteTitle);
    remoteTitle = url.searchParams.get("song");
    return new Response("Metadata updated");
  });
  fixture.publisher.publish("Și tu");
  await flushRequests();
  fixture.publisher.publish("Și tu");
  await fixture.reconcile();
  assert.equal(fixture.messages.filter((line) => line.includes("Și tu")).length, 1);
  assert.equal(fixture.messages.some((line) => line.includes("Detected from AutoDJ")), false);
  assert.equal(fixture.warnings.length, 0);
});

test("keeps retrying through an outage without flooding logs or needing a new track", async (context) => {
  let online = true;
  let remoteTitle = "";
  const fixture = publisherFixture(context, async (url) => {
    if (!online) throw new Error("Connection refused");
    if (url.pathname === "/currentsong") return new Response(remoteTitle);
    remoteTitle = url.searchParams.get("song");
    return new Response("Metadata updated");
  });
  fixture.publisher.publish("Melodia curentă");
  await flushRequests();
  online = false;
  remoteTitle = "";
  for (let attempt = 0; attempt < 5; attempt += 1) await fixture.reconcile();
  assert.equal(fixture.warnings.length, 1);
  online = true;
  await fixture.reconcile();
  assert.equal(remoteTitle, "Melodia curentă");
});

test("connection diagnostics identify the endpoint and error code without passwords", async (context) => {
  const fixture = publisherFixture(context, async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  });
  fixture.publisher.publish("Și tu");
  await flushRequests();
  await fixture.reconcile();
  assert.match(fixture.messages[0], /via http:\/\/127\.0\.0\.1:8000/);
  assert.match(fixture.warnings[0], /http:\/\/127\.0\.0\.1:8000.*ECONNREFUSED/);
  assert.doesNotMatch(fixture.warnings.join("\n"), /global-secret|stream-secret/);
});

test("a slow stream does not block title restoration on another stream", async (context) => {
  const titles = new Map([[1, ""], [2, ""]]);
  let holdFirstRead = false;
  let releaseRead;
  const fixture = publisherFixture(context, async (url) => {
    const streamId = Number(url.searchParams.get("sid"));
    if (url.pathname === "/currentsong") {
      if (streamId === 1 && holdFirstRead) {
        holdFirstRead = false;
        return new Promise((resolve) => { releaseRead = () => resolve(new Response("")); });
      }
      return new Response(titles.get(streamId));
    }
    titles.set(streamId, url.searchParams.get("song"));
    return new Response("Metadata updated");
  }, [1, 2]);
  fixture.publisher.publish("Și tu");
  await flushRequests();
  titles.set(1, "");
  titles.set(2, "");
  holdFirstRead = true;
  const pending = fixture.reconcile();
  try {
    await flushRequests();
    assert.equal(titles.get(2), "Și tu");
  } finally {
    releaseRead();
    await pending;
  }
  assert.equal(titles.get(1), "Și tu");
});

test("a track change cancels stale password retries and publishes the newest title", async (context) => {
  let releaseUpdate;
  let remoteTitle = "";
  const updates = [];
  const fixture = publisherFixture(context, async (url) => {
    if (url.pathname === "/currentsong") return new Response(remoteTitle);
    const title = url.searchParams.get("song");
    updates.push(title);
    if (updates.length === 1) {
      return new Promise((resolve) => {
        releaseUpdate = () => resolve(new Response("Metadata update rejected as the stream does not exist"));
      });
    }
    remoteTitle = title;
    return new Response("Metadata updated");
  });
  fixture.publisher.publish("Titlul vechi");
  fixture.publisher.publish("Titlul nou — Музыка");
  releaseUpdate();
  await flushRequests();
  assert.deepEqual(updates, ["Titlul vechi", "Titlul nou — Музыка"]);
  assert.equal(remoteTitle, "Titlul nou — Музыка");
  assert.equal(fixture.messages.filter((line) => line.includes("Published to SHOUTcast")).length, 1);
});

test("stopping the publisher cancels follow-up requests from an in-flight update", async (context) => {
  let releaseUpdate;
  const requests = [];
  const fixture = publisherFixture(context, async (url) => {
    requests.push(url.pathname);
    return new Promise((resolve) => {
      releaseUpdate = () => resolve(new Response("Invalid password"));
    });
  });
  fixture.publisher.publish("Și tu");
  fixture.publisher.stop();
  releaseUpdate();
  await flushRequests();
  assert.deepEqual(requests, ["/admin.cgi"]);
});

test("restores a UTF-8 title across a real HTTP server stop and restart", { timeout: 10000 }, async () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-http-restart-test-"));
  let remoteTitle = "";
  let sourceReady = true;
  const updates = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/currentsong") {
      response.writeHead(remoteTitle ? 200 : 404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(remoteTitle);
    } else if (!sourceReady) {
      response.end("Metadata update rejected as the stream does not exist");
    } else {
      remoteTitle = url.searchParams.get("song");
      updates.push(remoteTitle);
      response.end("Metadata updated");
    }
  });
  let publisher;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    fs.writeFileSync(path.join(serverRoot, "sc_serv.conf"), `PortBase=${port}\nstreamid_1=1\nadminpassword=test-secret\n`);
    publisher = startMetadataPublisher({
      serverRoot, streamIds: [1], environment: {}, retryDelaysMs: [], reconcileIntervalMs: 25,
      logger: { log() {}, warn() {} },
    });
    const title = "Cântec — Радио 🎵";
    publisher.publish(title);
    await waitUntil(() => remoteTitle === title, "Initial title was not published");
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    remoteTitle = "";
    sourceReady = false;
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(remoteTitle, "");
    sourceReady = true;
    await waitUntil(() => remoteTitle === title, "Title was not restored without a new metadata event");
    assert.deepEqual(updates, [title, title]);
  } finally {
    publisher?.stop();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});
