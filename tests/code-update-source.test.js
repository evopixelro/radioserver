const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = require("../app/code-update-source");

function snapshot() {
  const root = path.resolve(__dirname, "..");
  const names = fs.readdirSync(root).filter(source.managedPath);
  names.push("app/cli.js", "app/code-updater.js", "app/code-update-source.js");
  return { commit: "a".repeat(40), files: names.map((name) => {
    const bytes = fs.readFileSync(path.join(root, name));
    return { path: name, bytes, hash: source.sha256(bytes), mode: 0o644 };
  }) };
}

function network(value, replace = () => undefined) {
  const treeSha = "b".repeat(40);
  const tree = { sha: treeSha, truncated: false, tree: value.files.map((file) => ({
    path: file.path, type: "blob", mode: "100644", size: file.bytes.length, sha: source.blobHash(file.bytes),
  })) };
  const calls = [];
  return {
    calls,
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      const override = replace(url, tree);
      if (override) return override;
      if (url.endsWith("/commits/main")) return Response.json({ sha: value.commit, commit: { tree: { sha: treeSha } } });
      if (url.includes("/git/trees/")) return Response.json(tree);
      const file = value.files.find((entry) => url.endsWith(`/${entry.path}`));
      assert.ok(file, url);
      return new Response(file.bytes);
    },
  };
}

test("GitHub updater pins all downloads to one commit and verifies blob contents", async () => {
  const value = snapshot();
  const mock = network(value);
  const downloaded = await source.downloadSnapshot({ ...mock, log() {} });
  assert.equal(downloaded.commit, value.commit);
  assert.equal(downloaded.files.length, value.files.length);
  for (const call of mock.calls) {
    assert.match(call.url, /^https:\/\/(?:api\.github\.com|raw\.githubusercontent\.com)\//);
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal);
    if (call.url.includes("raw.githubusercontent")) assert.ok(call.url.includes(`/${value.commit}/`));
    assert.equal(call.options.headers.Authorization, undefined);
  }
});

for (const name of ["../server.js", "app/../server.js", "app\\escape.js", "app/a:b.js", "/server.js", "app/nul.txt", "app/COM1.js", "app/a. /x.js", "app/\u001b.js"]) {
  test(`updater rejects non-portable or escaping path ${JSON.stringify(name)}`, () => assert.equal(source.safePath(name), false));
}

test("updater scopes downloads to code, repository metadata and example templates", () => {
  for (const name of ["app/a.js", "app/autodj-playlist.liq", "tests/fixtures/title.txt", "sc_serv.conf.example"]) assert.equal(source.managedPath(name), true, name);
  for (const name of ["README.md", "LICENSE", "sc_serv.conf", "autodj.config.json", "playlist.config.json", "app/.env.json", "app/nested/.secrets.json", "app/song.mp3",
    "bin/tool.js", "playlists/song.js", "logs/log.js", ".run/state.js", "node_modules/lib.js", "start", "radioserver"]) {
    assert.equal(source.managedPath(name), false, name);
  }
});

test("README and LICENSE are not downloaded or required in the code snapshot", async () => {
  const value = snapshot();
  source.validateSnapshot(value);
  for (const name of ["README.md", "LICENSE"]) {
    const bytes = Buffer.from(`upstream ${name}`);
    value.files.push({ path: name, bytes, hash: source.sha256(bytes), mode: 0o644 });
  }
  const mock = network(value);
  const downloaded = await source.downloadSnapshot({ ...mock, log() {} });
  assert.ok(downloaded.files.every((entry) => !source.preservedDocument(entry.path)));
  assert.ok(mock.calls.every(({ url }) => !/\/(?:README\.md|LICENSE)$/.test(url)));
});

test("tree validation rejects truncation, links, oversized files and case collisions", () => {
  const entry = { path: "app/a.js", mode: "100644", type: "blob", sha: "a".repeat(40), size: 10 };
  assert.throws(() => source.selectFiles({ tree: [entry], truncated: true }), /incomplete/);
  for (const override of [{ mode: "120000" }, { type: "commit", mode: "160000" }, { size: source.MAX_FILE_BYTES + 1 }, { sha: "invalid" }]) {
    assert.throws(() => source.selectFiles({ tree: [{ ...entry, ...override }], truncated: false }), /Unsupported/);
  }
  assert.throws(() => source.selectFiles({ tree: [entry, { ...entry, path: "app/A.js" }], truncated: false }), /collide/);
  assert.equal(source.selectFiles({ tree: [{ ...entry, path: "bin/runtime.js" }], truncated: false }).length, 0);
});

test("damaged raw downloads cannot produce an installable snapshot", async () => {
  const mock = network(snapshot(), (url) => url.includes("raw.githubusercontent.com") ? new Response("damaged") : undefined);
  await assert.rejects(source.downloadSnapshot({ ...mock, log() {} }), /checksum mismatch/);
});

for (const status of [404, 403, 429, 500]) {
  test(`GitHub HTTP ${status} is an error, never an obsolete-file signal`, async () => {
    await assert.rejects(source.downloadSnapshot({ log() {}, fetchImplementation: async () => new Response("failed", { status }) }), new RegExp(`HTTP ${status}`));
  });
}

test("response size is bounded even without Content-Length", async () => {
  const mock = network(snapshot(), (url) => url.includes("raw.githubusercontent.com") ? new Response(Buffer.alloc(source.MAX_FILE_BYTES + 1)) : undefined);
  await assert.rejects(source.downloadSnapshot({ ...mock, log() {} }), /size limit/);
});

test("published snapshot must include the updater, valid JavaScript and compatible package metadata", () => {
  const value = snapshot();
  source.validateSnapshot(value, "22.0.0");
  source.validateSnapshot(value, "24.19.0");
  assert.throws(() => source.validateSnapshot(value, "21.99.99"), /Update Node.js first/);
  assert.throws(() => source.validateSnapshot({ ...value, files: value.files.filter((file) => file.path !== "app/code-updater.js") }), /Publish the complete updater/);
  const change = (name, bytes) => ({ ...value, files: value.files.map((file) => file.path === name ? { ...file, bytes, hash: source.sha256(bytes) } : file) });
  assert.throws(() => source.validateSnapshot(change("server.js", Buffer.from("function {"))), /JavaScript is invalid/);
  assert.throws(() => source.validateSnapshot(change("package.json", Buffer.from("{}"))), /inconsistent/);
  assert.throws(() => source.validateSnapshot(change("package-lock.json", Buffer.from("bad JSON"))), /invalid JSON/);
});

test("updater rejects a tree from a different commit", async () => {
  const mock = network(snapshot(), (url, tree) => url.includes("/git/trees/") ? Response.json({ ...tree, sha: "c".repeat(40) }) : undefined);
  await assert.rejects(source.downloadSnapshot({ ...mock, log() {} }), /does not match/);
});
