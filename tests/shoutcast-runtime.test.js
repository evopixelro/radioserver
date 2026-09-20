const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const manager = require("../app/process-manager");
const state = require("../app/process-state");
const { withControlLock } = require("../app/control-lock");
const platform = require("../app/platform");
const { DEFAULT_CONFIG, generateScript } = require("../app/liquidsoap-config");
const { getArguments } = require("../app/liquidsoap-runtime");

const binary = process.env.SHOUTCAST_TEST_BIN;
const liquidsoap = process.env.LIQUIDSOAP_TEST_BIN;

async function stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await closed; } finally { clearTimeout(timer); }
}

async function eventually(action, timeout = 20000) {
    const end = Date.now() + timeout;
    let error;
    do {
        try { return await action(); }
        catch (failure) { error = failure; }
        await delay(250);
    } while (Date.now() < end);
    throw error;
}

async function availablePorts() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const first = net.createServer();
        const second = net.createServer();
        try {
            first.listen(0, "127.0.0.1");
            await once(first, "listening");
            const port = first.address().port;
            if (port >= 65535) continue;
            second.listen(port + 1, "127.0.0.1");
            await once(second, "listening");
            return port;
        } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
        finally {
            await Promise.all([first, second].map((server) => new Promise((resolve) => server.close(resolve))));
        }
    }
    throw new Error("Could not reserve adjacent SHOUTcast test ports");
}

async function fixture(context) {
    const port = await availablePorts();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-dnas-test-"));
    const children = [];
    const config = {
        serverRoot: root, runtimeProfile: platform.resolveProfile(), binaryPath: binary, binarySource: "SC_SERV_BIN",
        runDirectory: path.join(root, ".run"), logDirectory: path.join(root, "logs"),
        configPath: path.join(root, "sc_serv.conf"), pidPath: path.join(root, ".run", "sc_serv.pid"),
        stdoutLogPath: path.join(root, "logs", "stdout.log"), stderrLogPath: path.join(root, "logs", "stderr.log"),
    };
    const control = (action) => withControlLock(config.runDirectory, action, { operation: "SHOUTcast integration test" });
    context.after(async () => {
        try {
            for (const child of children) await stopChild(child);
            await control(() => manager.stop(config));
        }
        finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
    });
    fs.writeFileSync(config.configPath, [
        `portbase=${port}`, "srcip=127.0.0.1", "destip=127.0.0.1", "publicserver=never", "streampublicserver_1=never",
        "ypaddr=127.0.0.1", "ypport=9", "password=test-source-only", "adminpassword=test-admin-only",
        "streamid_1=1", "streampath_1=/test", "maxuser=4",
        `logfile=${path.join(root, "dnas.log")}`, `w3clog=${path.join(root, "w3c.log")}`,
        `banfile=${path.join(root, "ban.txt")}`, `ripfile=${path.join(root, "rip.txt")}`,
    ].join("\n") + "\n");
    const base = `http://127.0.0.1:${port}`;
    const ready = async () => {
        try {
            await eventually(async () => {
                assert.equal(manager.getStatus(config).running, true);
                const response = await fetch(`${base}/index.html`, { signal: AbortSignal.timeout(2000) });
                assert.equal(response.status, 200);
                assert.match(await response.text(), /SHOUTcast/i);
            });
        } catch (error) {
            const output = [config.stdoutLogPath, config.stderrLogPath, path.join(root, "dnas.log")]
                .filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "utf8").slice(-8000)).join("\n");
            throw new Error(`${error.message}\nSHOUTcast output:\n${output}`, { cause: error });
        }
    };
    return { root, port, config, base, control, ready, children };
}

test("real SHOUTcast starts, restarts and stops through the Node controller", {
    skip: !binary && "Set SHOUTCAST_TEST_BIN to test the real DNAS executable", timeout: 90000,
}, async (context) => {
    const f = await fixture(context);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.control(() => manager.start(f.config));
        await f.ready();
        const record = state.read(f.config);
        assert.ok(record.child?.pid, "the controller must record the actual DNAS process identity");
        assert.ok(state.inspect(record.child.pid));
        await f.control(() => manager.stop(f.config));
        assert.equal(manager.getStatus(f.config).running, false);
        await eventually(() => assert.equal(state.inspect(record.child.pid), null));
    }
});

test("native Liquidsoap streams MP3 and UTF-8 metadata through real SHOUTcast", {
    skip: (!binary || !liquidsoap) && "Set SHOUTCAST_TEST_BIN and LIQUIDSOAP_TEST_BIN", timeout: 90000,
}, async (context) => {
    const f = await fixture(context);
    await f.control(() => manager.start(f.config));
    await f.ready();
    const title = "Și tu — Радио";
    const wave = Buffer.alloc(44 + 44100 * 4 * 2);
    wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
    wave.writeUInt32LE(44100, 24); wave.writeUInt32LE(44100 * 4, 28);
    wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
    wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
    const audio = path.join(f.root, "silence.wav");
    fs.writeFileSync(audio, wave);
    const playlistPath = path.join(f.root, "test.lst");
    fs.writeFileSync(playlistPath, `annotate:song=${JSON.stringify(title)}:${audio.replaceAll("\\", "/")}\n`);
    const script = path.join(f.root, "test.liq");
    fs.writeFileSync(script, generateScript({
        ...DEFAULT_CONFIG,
        server: { ...DEFAULT_CONFIG.server, port: f.port, password: "test-source-only", public: false },
        playlistSources: [{ id: "test", playlistPath, weight: 1 }],
    }));
    const child = spawn(liquidsoap, getArguments(liquidsoap, [script]), { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
    f.children.push(child);
    let output = "";
    child.on("error", (error) => { output += error.message; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
    try {
        await eventually(async () => {
            assert.equal(child.exitCode, null, output);
            const response = await fetch(`${f.base}/stats?sid=1&json=1`, { signal: AbortSignal.timeout(2000) });
            assert.equal(response.status, 200);
            const stats = await response.json();
            assert.equal(Number(stats.streamstatus), 1);
            assert.equal(stats.songtitle, title);
        }, 45000);
        const response = await fetch(`${f.base}/test`, { signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /audio\/mpeg/);
        const reader = response.body.getReader();
        let bytes = 0;
        try {
            while (bytes < 8192) {
                const chunk = await reader.read();
                assert.equal(chunk.done, false);
                bytes += chunk.value.length;
            }
        } finally { await reader.cancel(); }
    } catch (error) {
        throw new Error(`${error.message}\nLiquidsoap output:\n${output}`, { cause: error });
    }
});
