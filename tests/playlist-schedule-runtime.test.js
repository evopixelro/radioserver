const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { formatPlaylistEntries } = require("../app/playlist-generator");
const { getArguments } = require("../app/liquidsoap-runtime");
const { parseVersion, versionIsSupported } = require("../app/autodj-manager");
const { DEFAULT_CONFIG, generateScript } = require("../app/liquidsoap-config");

const binary = process.env.LIQUIDSOAP_TEST_BIN;

test("real Liquidsoap switches after the current track and respects weights, scheduled priority and fallback", {
    skip: !binary && "Set LIQUIDSOAP_TEST_BIN to Liquidsoap >=2.4.5 to test scheduled playback",
    timeout: 60000,
}, async (context) => {
    const reported = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(reported.status, 0, reported.error?.message || reported.stderr);
    const version = parseVersion(`${reported.stdout}\n${reported.stderr}`);
    assert.ok(version, "Liquidsoap must report its version");
    if (!versionIsSupported(version, [2, 4, 5])) {
        context.skip("Scheduled playback requires Liquidsoap >=2.4.5");
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-schedule-runtime-"));
    const wave = Buffer.alloc(44 + 44100 * 4);
    wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
    wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(44100 * 4, 28);
    wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
    wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    const writeList = (name, names) => {
        const files = names.map((title) => {
            const file = path.join(root, `${title}.wav`);
            fs.writeFileSync(file, title === "broken" ? "not audio" : wave);
            return file;
        });
        const file = path.join(root, `${name}.lst`);
        fs.writeFileSync(file, `${formatPlaylistEntries(files, { pathMode: "absolute" }, root).join("\n")}\n`);
        return file.replaceAll("\\", "/");
    };
    let child;
    let timeout;
    try {
        const regular = writeList("regular", ["A", "B"]);
        const scheduled = writeList("scheduled", ["C", "D"]);
        const overlap = writeList("overlap", ["E"]);
        const solo = writeList("solo", ["A"]);
        const broken = writeList("broken", ["broken"]);
        const validationPath = path.join(root, "generated-schedule.liq");
        fs.writeFileSync(validationPath, generateScript({
            ...DEFAULT_CONFIG,
            server: { ...DEFAULT_CONFIG.server, password: "test-only-password" },
            playlistSources: [
                { id: "regular", playlistPath: regular },
                { id: "scheduled", playlistPath: scheduled, schedule: [{ days: ["monday", "friday"], start: "12:00", end: "13:00" }] },
                { id: "weekend", playlistPath: overlap, schedule: [{ days: ["saturday", "sunday"] }] },
            ],
        }));
        const checked = spawnSync(binary, getArguments(binary, ["--check", validationPath]), {
            cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000,
        });
        assert.ifError(checked.error);
        assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
        const active = "[{start=60, stop=120}]";
        const cases = [
            { id: "boundary", minute: 59, lists: [[regular, 1, "[]"], [scheduled, 2, active], [overlap, 1, active]] },
            { id: "fallback", minute: 60, lists: [[regular, 1, "[]"], [broken, 1, active]] },
            { id: "priority", minute: 60, lists: [[regular, 1, "[]"], [overlap, 1, active]] },
            { id: "inactive", minute: 120, lists: [[solo, 1, "[]"], [scheduled, 1, active]] },
            { id: "silence", minute: 120, lists: [[scheduled, 1, active]], empty: true },
            { id: "recovery", minute: 59, lists: [[scheduled, 1, active]], recover: true },
            { id: "random", minute: 60, mode: "random", lists: [[regular, 1, "[]"], [scheduled, 1, active]] },
            { id: "randomize", minute: 60, mode: "randomize", lists: [[regular, 1, "[]"], [scheduled, 1, active]] },
            { id: "consecutive", minute: 60, lists: [[regular, 1, "[]"], [scheduled, 1, active], [overlap, 1, "[{start=120, stop=1440}]"]] },
            { id: "full_day", minute: 0, lists: [[regular, 1, "[]"], [overlap, 1, "[{start=0, stop=1440}]"]] },
        ];
        const histories = new Map(cases.map((entry) => [entry.id, []]));
        const lines = [
            "settings.log.file := false", "settings.log.stdout := true", "settings.log.level := 2",
            fs.readFileSync(path.join(__dirname, "../app/autodj-playlist.liq"), "utf8"),
        ];
        for (const entry of cases) {
            const name = `schedule_${entry.id}`;
            lines.push(`${name}_minute = ref(${entry.minute})`, `${name}_count = ref(0)`);
            if (entry.recover) {
                lines.push(`${name}_checks = ref(0)`, `def ${name}_clock() =`);
                lines.push(`  ref.incr(${name}_checks)`);
                lines.push(`  if ${name}_checks() <= 2 then 59 else 60 end`, "end");
            } else lines.push(`def ${name}_clock() = ${name}_minute() end`);
            lines.push(`${name} = radio_program(id=${JSON.stringify(name)}, mode=${JSON.stringify(entry.mode || "normal")}, reload=300,`);
            lines.push(`  schedule_time=${name}_clock, schedules=[${entry.lists.map((list) => list[2]).join(", ")}],`);
            lines.push(`  [${entry.lists.map(([uri, weight]) => `{uri=${JSON.stringify(uri)}, weight=${weight}}`).join(", ")}])`);
            lines.push(`def ${name}_track(m) =`);
            lines.push(`  print("[SCHEDULE:${entry.id}] " ^ json.stringify(compact=true, {song=m["song"], audio_time=source.time(${name})}))`);
            lines.push(`  ref.incr(${name}_count)`);
            if (entry.id === "boundary") {
                // Change the injected clock while the one-second track is still playing.
                // A stale prefetched request would produce A, B rather than A, C.
                lines.push(`  if ${name}_count() == 1 then ${name}_minute := 60 end`);
                lines.push(`  if ${name}_count() == 4 then ${name}_minute := 120 end`);
            }
            if (entry.id === "consecutive") {
                lines.push(`  if ${name}_count() == 1 then ${name}_minute := 120 end`);
                lines.push(`  if ${name}_count() == 3 then ${name}_minute := 1440 end`);
            }
            if (entry.id === "full_day") {
                lines.push(`  if ${name}_count() == 1 then ${name}_minute := 1440 end`);
            }
            lines.push("end", `${name}.on_track(synchronous=true, ${name}_track)`);
            lines.push(`output.dummy(mksafe(${name}))`);
        }
        const script = path.join(root, "schedule.liq");
        fs.writeFileSync(script, `${lines.join("\n")}\n`);
        let pending = "";
        let output = "";
        const times = [];
        await new Promise((resolve, reject) => {
            child = spawn(binary, getArguments(binary, [script]), {
                cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                output = (output + chunk).slice(-65536);
                pending += chunk;
                const rows = pending.split(/\r?\n/);
                pending = rows.pop();
                for (const row of rows) {
                    const match = /^\[SCHEDULE:(\w+)\] (.+)$/.exec(row);
                    if (!match) continue;
                    const event = JSON.parse(match[2]);
                    histories.get(match[1]).push(event.song);
                    if (match[1] === "boundary") times.push(event.audio_time);
                }
                if (cases.every((entry) => entry.empty || histories.get(entry.id).length >= 5)) resolve();
            });
            child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-65536); });
            child.on("error", reject);
            child.on("exit", (code) => reject(new Error(`Liquidsoap exited ${code}: ${output}`)));
            timeout = setTimeout(() => reject(new Error(`Scheduled playback timed out: ${JSON.stringify([...histories])}\n${output}`)), 35000);
        });
        assert.deepEqual(histories.get("boundary").slice(0, 5), ["A", "C", "D", "E", "B"]);
        assert.deepEqual(histories.get("fallback").slice(0, 5), ["A", "B", "A", "B", "A"]);
        assert.deepEqual(histories.get("priority").slice(0, 5), ["E", "E", "E", "E", "E"]);
        assert.deepEqual(histories.get("inactive").slice(0, 5), ["A", "A", "A", "A", "A"]);
        assert.deepEqual(histories.get("silence"), []);
        assert.deepEqual(histories.get("recovery").slice(0, 5), ["C", "D", "C", "D", "C"]);
        assert.deepEqual(histories.get("consecutive").slice(0, 5), ["C", "E", "E", "A", "B"]);
        assert.deepEqual(histories.get("full_day").slice(0, 5), ["E", "A", "B", "A", "B"]);
        for (const id of ["random", "randomize"]) {
            const titles = histories.get(id);
            assert.ok(titles.every((title) => ["C", "D"].includes(title)), `${id}: inactive playlists must not play`);
            for (let index = 1; index < titles.length; index += 1) assert.notEqual(titles[index], titles[index - 1], id);
        }
        for (let index = 1; index < 5; index += 1) {
            // Measure decoded audio, not wall time: a busy host can deliver callbacks in bursts.
            const duration = times[index] - times[index - 1];
            assert.ok(duration >= 0.9 && duration <= 1.1,
                `Scheduled transitions must preserve the one-second track: ${JSON.stringify(times)}`);
        }
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
