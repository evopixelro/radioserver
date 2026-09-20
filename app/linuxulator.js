const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LOADER = "/compat/linux/lib64/ld-linux-x86-64.so.2";
const INTERPRETER = "/lib64/ld-linux-x86-64.so.2";

function readHeader(binary) {
    const descriptor = fs.openSync(binary, "r");
    try {
        const data = Buffer.alloc(65536);
        return data.subarray(0, fs.readSync(descriptor, data, 0, data.length, 0));
    } finally { fs.closeSync(descriptor); }
}

function isLinuxBinary(binary, readFile = fs.readFileSync) {
    try {
        const data = readFile === fs.readFileSync ? readHeader(binary) : readFile(binary);
        if (data.length < 64 || data.toString("hex", 0, 4) !== "7f454c46" ||
                data[4] !== 2 || data[5] !== 1 || data[6] !== 1 ||
                ![0, 3].includes(data[7]) || data.readUInt16LE(18) !== 62 ||
                ![2, 3].includes(data.readUInt16LE(16))) return false;
        const table = Number(data.readBigUInt64LE(32));
        const size = data.readUInt16LE(54);
        const count = data.readUInt16LE(56);
        if (!Number.isSafeInteger(table) || size < 56 || count > 1024 || table + size * count > data.length) return false;
        for (let index = 0; index < count; index += 1) {
            const header = table + index * size;
            if (data.readUInt32LE(header) !== 3) continue;
            const offset = Number(data.readBigUInt64LE(header + 8));
            const length = Number(data.readBigUInt64LE(header + 32));
            return Number.isSafeInteger(offset) && length === INTERPRETER.length + 1 &&
                data.subarray(offset, offset + length).equals(Buffer.from(`${INTERPRETER}\0`));
        }
    } catch {}
    return false;
}

function requirements(profile, existing = {}, { run = spawnSync, exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
    if (profile.id !== "freebsd-x64" || (existing.found && !isLinuxBinary(existing.path, readFile))) {
        return { items: [], missing: [] };
    }
    const options = { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    const kernel = run("sysctl", ["-n", "kern.features.linux64"], options);
    const enabled = !kernel.error && kernel.status === 0 && String(kernel.stdout).trim() === "1";
    const loader = exists(LOADER);
    const probe = enabled && loader ? run("/compat/linux/bin/true", [], options) : null;
    const works = Boolean(probe && !probe.error && probe.status === 0);
    const items = [
        { id: "compatibility:linux64", label: "Linuxulator x64 kernel support", found: enabled, detail: enabled ? "enabled" : "not enabled" },
        { id: "compatibility:linux-loader", label: "Linux x64 dynamic loader", found: loader, detail: loader ? LOADER : "Linux userland is missing" },
        { id: "compatibility:linux-userland", label: "Linux userland execution", found: works, detail: works ? "/compat/linux/bin/true runs successfully" : "Linux userland is missing or cannot execute" },
    ];
    return { items, missing: items.filter((item) => !item.found).map((item) => item.label) };
}

function installationHelp({ color = Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env) } = {}) {
    const commands = ['sysrc linux_enable="YES"', "service linux start", "pkg install linux_base-rl9"];
    return ["Enable SHOUTcast Linux compatibility separately (run as root on FreeBSD x64):",
        ...commands.map((command) => color ? `\u001b[33m${command}\u001b[0m` : command),
        "Linux libraries must be installed under /compat/linux; native FreeBSD libraries are not substitutes.",
        "RadioServer does not enable kernel modules or install OS packages. Rerun npm run install or npm run update as the service account."].join("\n");
}

function inspect(binary, run = spawnSync, environment = process.env) {
    const env = { ...environment, LC_ALL: "C" };
    delete env.LD_LIBRARY_PATH;
    delete env.LD_PRELOAD;
    return run(LOADER, ["--list", path.resolve(binary)], {
        encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], env,
    });
}

module.exports = { inspect, installationHelp, isLinuxBinary, requirements };
