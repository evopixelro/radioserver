const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseJsonWithComments } = require("../app/json-config");

test("parses JSONC comments, URLs and trailing commas", () => {
  const config = parseJsonWithComments(
    [
      "{",
      "  // Line comment",
      '  "url": "https://example.com/path//file",',
      "  /* Block comment */",
      '  "values": [1, 2,],',
      "}",
    ].join("\n"),
  );

  assert.deepEqual(config, {
    url: "https://example.com/path//file",
    values: [1, 2],
  });
});

test("both configuration templates contain valid JSONC", () => {
  const root = path.resolve(__dirname, "..");
  const autodj = parseJsonWithComments(
    fs.readFileSync(path.join(root, "autodj.config.json.example"), "utf8"),
  );
  const playlist = parseJsonWithComments(
    fs.readFileSync(path.join(root, "playlist.config.json.example"), "utf8"),
  );

  assert.equal(autodj.outputs.length, 1);
  assert.equal(autodj.outputs[0].id, "main");
  assert.equal(playlist.playlists.length, 1);
  assert.equal(playlist.playlists[0].id, "universal");
});
