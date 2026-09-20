const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const opam = require("../app/liquidsoap-opam");
const { activateRuntime } = require("../app/dependencies");

for (const family of ["linux", "macos", "freebsd"]) {
    test(`${family} source build uses a private switch and the exact official version`, (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-opam-"));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        // Simulated Unix builds also run on Windows hosts without symlink privileges.
        const links = context.mock.method(fs, "symlinkSync", (source, destination) => fs.copyFileSync(source, destination));
        const commands = [];
        const profile = { family, id: `${family}-x64` };
        const parent = path.join(root, "bin", "liquidsoap");
        const result = opam.install(root, profile, "2.4.5", {
            userId: 1000,
            run(command, args, options) {
                commands.push({ command, args, options });
                if (command === "opam" && args[0] === "install") {
                    const switchName = args.find((value) => value.startsWith("--switch=")).slice(9);
                    const binary = path.join(parent, "opam", switchName, "bin", "liquidsoap");
                    fs.mkdirSync(path.dirname(binary), { recursive: true });
                    fs.writeFileSync(binary, "compiled latest runtime");
                    assert.equal(options.env.OPAMROOT, path.join(parent, "opam"));
                    assert.equal(options.env.OPAMREQUIRECHECKSUMS, "1");
                }
                return { status: 0 };
            },
            validate: (binary) => ({ ok: fs.readFileSync(binary, "utf8") === "compiled latest runtime" }),
            verify: (_binary, version) => assert.equal(version, "2.4.5"),
            activate: activateRuntime,
        });
        assert.equal(result, path.join(parent, profile.id, "liquidsoap"));
        assert.equal(links.mock.callCount(), 1);
        const install = commands.find(({ args }) => args[0] === "install");
        assert.ok(install.args.includes("liquidsoap.2.4.5"));
        assert.ok(install.args.includes("ffmpeg"));
        assert.ok(install.args.includes("--no-depexts"));
        assert.ok(install.args.includes("--require-checksums"));
        assert.ok(commands.find(({ args }) => args[0] === "init").args.includes("https://opam.ocaml.org"));
        assert.equal(commands.some(({ args }) => args.includes("--disable-sandboxing")), false);
        const manifest = JSON.parse(fs.readFileSync(path.join(parent, profile.id, "runtime.json"), "utf8"));
        assert.equal(manifest.version, "2.4.5");
        assert.equal(manifest.method, "opam");
    });
}

for (const failure of ["compile", "validation", "version", "activation"]) {
    test(`source ${failure} failure preserves the previous runtime and removes only the new switch`, (context) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-opam-failure-"));
        context.after(() => fs.rmSync(root, { recursive: true, force: true }));
        context.mock.method(fs, "symlinkSync", (_source, destination) => fs.writeFileSync(destination, "new runtime"));
        const runtime = path.join(root, "bin", "liquidsoap", "linux-x64");
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(path.join(runtime, "liquidsoap"), "old runtime");
        const commands = [];
        assert.throws(() => opam.install(root, { family: "linux", id: "linux-x64" }, "2.4.5", {
            userId: 1000,
            run(_command, args) {
                commands.push(args);
                return { status: failure === "compile" && args[0] === "install" ? 1 : 0 };
            },
            validate: () => ({ ok: failure !== "validation", detail: "TEST_VALIDATION" }),
            verify: () => { if (failure === "version") throw new Error("TEST_VERSION"); },
            activate: () => { throw new Error("TEST_ACTIVATION"); },
        }), /source build failed|TEST_/);
        assert.equal(fs.readFileSync(path.join(runtime, "liquidsoap"), "utf8"), "old runtime");
        const created = commands.find((args) => args[0] === "switch" && args[1] === "create")[2];
        const removed = commands.filter((args) => args[0] === "switch" && args[1] === "remove");
        assert.deepEqual(removed.map((args) => args[2]), [created]);
    });
}

test("source builds refuse root and unsupported Windows targets", () => {
    assert.throws(() => opam.prerequisites({ family: "linux", id: "linux-x64" }, { userId: 0 }), /not root/);
    assert.throws(() => opam.prerequisites({ family: "windows", id: "windows-arm64" }), /No supported source build/);
});

test("missing build tools are reported without installing OS packages", () => {
    assert.throws(() => opam.prerequisites({ family: "freebsd" }, { userId: 1000,
        run: (command) => ({ status: command === "gmake" ? 1 : 0 }),
    }), /gmake.*does not install OS packages/);
});
