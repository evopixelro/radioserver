const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { formatPlaylistEntries } = require("../app/playlist-generator");
const { getArguments } = require("../app/liquidsoap-runtime");

const binary = process.env.LIQUIDSOAP_TEST_BIN;

test("real Liquidsoap prevents adjacent names across modes, weights, reloads and crossfades, with an unavailable-alternative exception", {
  skip: !binary && "Set LIQUIDSOAP_TEST_BIN to test real anti-repeat scheduling",
  timeout: 60000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-anti-repeat-"));
  const histories = new Map();
  const wave = Buffer.alloc(44 + 44100 * 4);
  wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(44100 * 4, 28);
  wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
  wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
  let child;
  let timeout;
  let output = "";
  let pending = "";
  let edited = false;
  let expanded = false;
  const writeAudio = (name) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name.includes("broken") ? "not audio" : wave);
    return file;
  };
  const a = writeAudio("universal/Și tu.wav");
  const duplicate = writeAudio("pop/ȘI TU.wav");
  const b = writeAudio("universal/Радио.wav");
  const c = writeAudio("pop/Altă melodie.wav");
  const broken = writeAudio("broken.wav");
  const missing = path.join(root, "missing.wav");
  const writeList = (name, files) => {
    const file = path.join(root, `${name}.lst`);
    fs.writeFileSync(file, `${formatPlaylistEntries(files, { pathMode: "absolute" }, root).join("\n")}\n`);
    return file.replaceAll("\\", "/");
  };
  const universal = writeList("universal", [a, b]);
  const pop = writeList("pop", [duplicate, c]);
  const solo = writeList("solo", [a, duplicate, broken, missing]);
  const invalid = writeList("invalid", [broken, missing]);
  const reloaded = writeList("reloaded", [a, b]);
  const exclusive = writeList("exclusive", [c]);
  const expanding = writeList("expanding", [a]);
  const cases = [
    { id: "normal", mode: "normal", lists: [[universal, 4], [pop, 1]] },
    { id: "random", mode: "random", lists: [[universal, 1]] },
    { id: "randomize", mode: "randomize", lists: [[universal, 1]] },
    { id: "crossfade", mode: "randomize", lists: [[universal, 1], [pop, 1]], crossfade: true },
    { id: "weighted", mode: "normal", lists: [[universal, 2], [exclusive, 1]] },
    { id: "reload", mode: "normal", lists: [[reloaded, 1]] },
    { id: "solo", mode: "normal", lists: [[solo, 1]], repeat: true },
    { id: "independent", mode: "normal", lists: [[exclusive, 1]], repeat: true },
    { id: "expanding", mode: "normal", lists: [[expanding, 1]], expand: true },
    { id: "invalid", mode: "normal", lists: [[invalid, 1]], empty: true },
  ];
  const lines = ["settings.log.file := false", "settings.log.stdout := true", "settings.log.level := 2",
    fs.readFileSync(path.join(__dirname, "../app/autodj-playlist.liq"), "utf8")];
  for (const entry of cases) {
    histories.set(entry.id, []);
    const variable = `test_${entry.id}`;
    lines.push(`${variable} = radio_program(id=${JSON.stringify(entry.id)}, mode=${JSON.stringify(entry.mode)}, reload=1, [${entry.lists.map(([uri, weight]) => `{uri=${JSON.stringify(uri)}, weight=${weight}}`).join(", ")}])`);
    if (entry.crossfade) lines.push(`${variable} = crossfade(duration=0.1, ${variable})`);
    const callback = `${variable}.${entry.crossfade ? "on_metadata" : "on_track"}`;
    const handler = `fun (m) -> print("[ANTI_REPEAT:${entry.id}] " ^ json.stringify(compact=true, m["song"]))`;
    lines.push("%ifversion >= 2.4", `${callback}(synchronous=true, ${handler})`, "%else", `${callback}(${handler})`, "%endif");
    lines.push(`output.dummy(fallible=true, ${variable})`);
  }
  const script = path.join(root, "test.liq");
  fs.writeFileSync(script, `${lines.join("\n")}\n`);
  try {
    await new Promise((resolve, reject) => {
      child = spawn(binary, getArguments(binary, [script]), { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const consume = (chunk) => {
        output = (output + chunk).slice(-65536);
        pending += chunk;
        const rows = pending.split(/\r?\n/);
        pending = rows.pop();
        for (const row of rows) {
          const match = /^\[ANTI_REPEAT:(\w+)\] (.+)$/.exec(row);
          if (!match) continue;
          histories.get(match[1]).push(JSON.parse(match[2]));
          if (match[1] === "reload" && histories.get("reload").length === 3 && !edited) {
            edited = true;
            writeList("reloaded", [b, a]);
          }
          if (match[1] === "expanding" && histories.get("expanding").length === 3 && !expanded) {
            expanded = true;
            writeList("expanding", [a, b]);
          }
        }
        if (cases.every((entry) => entry.empty || histories.get(entry.id).length >= 8)) resolve();
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", consume);
      child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-65536); });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`Liquidsoap exited ${code}: ${output}`)));
      timeout = setTimeout(() => reject(new Error(`Scheduling timed out: ${JSON.stringify([...histories])}\n${output}`)), 45000);
    });
    for (const entry of cases) {
      const titles = histories.get(entry.id).map((title) => title.normalize("NFC").toLowerCase());
      if (entry.empty) assert.equal(titles.length, 0);
      else if (entry.repeat) assert.equal(new Set(titles).size, 1, entry.id);
      else if (entry.expand) {
        const firstAlternative = titles.indexOf("радио");
        assert.ok(firstAlternative >= 3 && firstAlternative <= 5, titles.join(" | "));
        for (let index = firstAlternative + 1; index < titles.length; index += 1) assert.notEqual(titles[index], titles[index - 1]);
      }
      else for (let index = 1; index < titles.length; index += 1) assert.notEqual(titles[index], titles[index - 1], `${entry.id}: ${titles.join(" | ")}`);
    }
    assert.deepEqual(histories.get("weighted").slice(0, 6), ["Și tu", "Радио", "Altă melodie", "Și tu", "Радио", "Altă melodie"]);
    assert.equal(edited, true);
    assert.equal(expanded, true);
    for (const id of ["solo", "independent", "expanding"]) {
      assert.equal(output.split(`[${id}:2] No different playable filename`).length - 1, 1, output);
    }
    assert.equal(output.split("[invalid:2] No playable tracks").length - 1, 1, output);
  } finally {
    clearTimeout(timeout);
    if (child?.pid && child.exitCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
