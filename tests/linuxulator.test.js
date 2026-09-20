const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const linuxulator = require("../app/linuxulator");
const native = require("../app/system-dependencies");

function executable() {
    const data = Buffer.alloc(256);
    data.write("\x7fELF", 0, "ascii");
    data[4] = 2; data[5] = 1; data[6] = 1;
    data.writeUInt16LE(2, 16); data.writeUInt16LE(62, 18);
    data.writeBigUInt64LE(64n, 32);
    data.writeUInt16LE(56, 54); data.writeUInt16LE(1, 56);
    data.writeUInt32LE(3, 64); data.writeBigUInt64LE(128n, 72);
    const interpreter = "/lib64/ld-linux-x86-64.so.2\0";
    data.writeBigUInt64LE(BigInt(interpreter.length), 96);
    data.write(interpreter, 128);
    return data;
}

test("Linuxulator recognizes the Linux x64 ELF interpreter, not a filename", () => {
    assert.equal(linuxulator.isLinuxBinary("sc_serv", executable), true);
    for (const mutate of [
        (data) => { data[7] = 9; },
        (data) => data.writeUInt16LE(183, 18),
        (data) => { data[4] = 1; },
        (data) => data.writeBigUInt64LE(9007199254740992n, 32),
        (data) => data.writeUInt16LE(65535, 56),
        (data) => data.writeUInt16LE(1, 54),
        (data) => data.writeBigUInt64LE(10000n, 72),
        (data) => data.write("/libexec/ld-elf.so.1\0", 128),
    ]) {
        const data = executable();
        mutate(data);
        assert.equal(linuxulator.isLinuxBinary("sc_serv", () => data), false);
    }
    assert.equal(linuxulator.isLinuxBinary("sc_serv", () => Buffer.alloc(3)), false);
    assert.equal(linuxulator.isLinuxBinary("missing", () => { throw new Error("missing"); }), false);
});

for (const missing of ["none", "kernel", "loader", "execution"]) {
    test(`Linuxulator checks kernel, loader and actual execution: ${missing}`, () => {
        const report = linuxulator.requirements({ id: "freebsd-x64" }, { found: false }, {
            exists: () => missing !== "loader",
            run(command, args) {
                if (command === "sysctl") {
                    assert.deepEqual(args, ["-n", "kern.features.linux64"]);
                    return { status: missing === "kernel" ? 1 : 0, stdout: "1\n" };
                }
                assert.equal(command, "/compat/linux/bin/true");
                return { status: missing === "execution" ? 1 : 0 };
            },
        });
        assert.equal(report.items.length, 3);
        assert.equal(report.missing.length === 0, missing === "none");
    });
}

test("native FreeBSD and other hosts do not require Linuxulator", () => {
    const run = () => assert.fail("must not probe Linux compatibility");
    for (const id of ["linux-x64", "windows-x64", "macos-x64", "freebsd-arm64", "freebsd-x86"]) {
        assert.deepEqual(linuxulator.requirements({ id }, {}, { run }).items, []);
    }
    assert.deepEqual(linuxulator.requirements({ id: "freebsd-x64" }, { found: true, path: "native" }, {
        run, readFile: () => Buffer.alloc(128),
    }).items, []);
});

test("Linux dependency checks use the Linux loader without native library overrides", () => {
    const report = native.inspect("./sc_serv", { family: "freebsd", architecture: "x64" }, {
        readFile: executable,
        environment: { PATH: "/usr/bin", LD_LIBRARY_PATH: "/native/lib", LD_PRELOAD: "/native/preload.so" },
        run(command, args, options) {
            assert.equal(command, "/compat/linux/lib64/ld-linux-x86-64.so.2");
            assert.deepEqual(args, ["--list", path.resolve("./sc_serv")]);
            assert.equal(options.env.LD_LIBRARY_PATH, undefined);
            assert.equal(options.env.LD_PRELOAD, undefined);
            return { status: 0, stdout: "libc.so.6 => /lib64/libc.so.6 (0x123)\nlibmissing.so => not found" };
        },
    });
    assert.equal(report.compatibility, "linuxulator");
    assert.deepEqual(report.missing, ["libmissing.so"]);
    assert.throws(() => native.assertAvailable("SHOUTcast", { family: "freebsd" }, report, { color: false }), /pkg install linux_base-rl9/);
});

test("FreeBSD compatibility commands are explicit and yellow only when requested", () => {
    const plain = linuxulator.installationHelp({ color: false });
    assert.match(plain, /sysrc linux_enable="YES"\nservice linux start\npkg install linux_base-rl9/);
    assert.doesNotMatch(plain, /\u001b\[/);
    assert.ok(linuxulator.installationHelp({ color: true }).includes("\u001b[33mpkg install linux_base-rl9\u001b[0m"));
});
