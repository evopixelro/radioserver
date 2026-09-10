const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  activateRuntime,
  extractLinuxPackage,
  getDependencyStatus,
  getLinuxInstallPlan,
  installDependencies,
  parseOsRelease,
  preflightInstall,
  LIQUIDSOAP_PACKAGES,
  WINDOWS_LIQUIDSOAP_PACKAGE,
} = require("../app/dependencies");
const { digestFile } = require("../app/download");
const { getArguments } = require("../app/liquidsoap-runtime");

test("parses Debian and Ubuntu os-release values", () => {
  assert.deepEqual(parseOsRelease('ID=debian\nVERSION_CODENAME="trixie"\n'), {
    distribution: "debian",
    codename: "trixie",
  });
  assert.deepEqual(parseOsRelease("ID=ubuntu\nVERSION_CODENAME=noble\n"), {
    distribution: "ubuntu",
    codename: "noble",
  });
});

test("historical checksum records contain only official asset URLs and valid SHA-256", () => {
  for (const item of [...LIQUIDSOAP_PACKAGES, WINDOWS_LIQUIDSOAP_PACKAGE]) {
    assert.match(item.url, /^https:\/\/github\.com\/savonet\/liquidsoap-release-assets\/releases\/download\//);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
});

test("extracts the complete Linux runtime without installing a system package", () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radioserver-liquidsoap-"));
  const archive = path.join(serverRoot, "runtime.deb");
  fs.writeFileSync(archive, "test archive");
  const commands = [];
  try {
    const executablePath = extractLinuxPackage(
      { filePath: archive, fileName: "runtime.deb", sha256: digestFile(archive), version: "2.2.5" },
      serverRoot,
      { family: "linux", architecture: "x64", id: "linux-x64" },
      {
        run(command, args) {
          commands.push([command, ...args.slice(0, 1)]);
          const staging = args[2];
          fs.mkdirSync(path.join(staging, "usr", "bin"), { recursive: true });
          fs.mkdirSync(path.join(staging, "usr", "share", "liquidsoap", "libs"), { recursive: true });
          fs.writeFileSync(path.join(staging, "usr", "bin", "liquidsoap"), "liquidsoap executable");
          fs.writeFileSync(path.join(staging, "usr", "share", "liquidsoap", "libs", "stdlib.liq"), "library");
          return { status: 0 };
        },
        validate(binary) {
          const args = getArguments(binary, ["--check", "()"]);
          assert.equal(args[0], "--no-stdlib");
          assert.equal(fs.readFileSync(args[1], "utf8"), "library");
          return { ok: true };
        },
      },
    );
    assert.equal(
      executablePath,
      path.join(serverRoot, "bin", "liquidsoap", "linux-x64", "usr", "bin", "liquidsoap"),
    );
    assert.equal(fs.readFileSync(executablePath, "utf8"), "liquidsoap executable");
    assert.deepEqual(commands, [["dpkg-deb", "--extract"]]);
    assert.equal(fs.readFileSync(getArguments(executablePath)[1], "utf8"), "library");
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

test("reports each runtime dependency separately", () => {
  const status = getDependencyStatus({
    serverRoot: path.resolve("C:/missing-radio-runtime"),
    runtimeProfile: { family: "windows", architecture: "x64", id: "windows-x64" },
  });
  assert.deepEqual(
    status.items.map(({ label, found }) => ({ label, found })),
    [
      { label: "Liquidsoap", found: false },
      { label: "FFmpeg", found: false },
    ],
  );
});

test("an incomplete Linux package preserves the existing local runtime", () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-install-rollback-"));
  try {
    const archive = path.join(serverRoot, "runtime.deb");
    const runtime = path.join(serverRoot, "bin", "liquidsoap", "linux-x64");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "liquidsoap"), "previous executable");
    fs.writeFileSync(archive, "broken package fixture");
    assert.throws(() => extractLinuxPackage(
      { filePath: archive, fileName: "runtime.deb", sha256: digestFile(archive) },
      serverRoot, { id: "linux-x64" },
      { run: () => ({ status: 0 }) },
    ), /stdlib.liq is missing/);
    assert.equal(fs.readFileSync(path.join(runtime, "liquidsoap"), "utf8"), "previous executable");
    assert.deepEqual(fs.readdirSync(path.dirname(runtime)), ["linux-x64"]);
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "activation-failed", "rollback-failed"]) {
  test(`nested runtime activation preserves the previous version when ${outcome}`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-activation-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, "windows-x64");
    const staging = path.join(root, "windows-x64.tmp-test");
    const extracted = path.join(staging, "liquidsoap-win64");
    for (const [directory, contents] of [[runtime, "previous"], [extracted, "new"]]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "liquidsoap.exe"), contents);
    }
    const rename = fs.renameSync;
    const renames = [];
    context.mock.method(fs, "renameSync", (source, destination) => {
      renames.push([source, destination]);
      if (outcome !== "success" && source === extracted) throw new Error("TEST_ACTIVATION_FAILED");
      if (outcome === "rollback-failed" && source !== runtime) throw new Error("TEST_RESTORATION_FAILED");
      return rename(source, destination);
    });
    if (outcome === "success") activateRuntime(extracted, runtime);
    else assert.throws(() => activateRuntime(extracted, runtime), (error) => {
      assert.match(error.message, /TEST_ACTIVATION_FAILED/);
      if (outcome === "rollback-failed") {
        assert.match(error.message, /TEST_RESTORATION_FAILED/);
        assert.ok(error.message.includes(renames[0][1]));
        assert.equal(error.cause.message, "TEST_ACTIVATION_FAILED");
      }
      return true;
    });
    fs.rmSync(staging, { recursive: true, force: true });
    const backup = renames[0][1];
    assert.equal(path.dirname(backup), root);
    if (outcome === "rollback-failed") {
      assert.equal(fs.existsSync(runtime), false);
      assert.equal(fs.readFileSync(path.join(backup, "liquidsoap.exe"), "utf8"), "previous");
    } else {
      assert.equal(fs.existsSync(backup), false);
      assert.equal(fs.readFileSync(path.join(runtime, "liquidsoap.exe"), "utf8"), outcome === "success" ? "new" : "previous");
    }
  });
}

test("missing shared libraries request only OS dependencies and preserve the current runtime", () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-shared-libs-"));
  try {
    const archive = path.join(serverRoot, "runtime.deb");
    fs.writeFileSync(archive, "dependency fixture");
    const commands = [];
    assert.throws(() => extractLinuxPackage(
      { filePath: archive, fileName: "runtime.deb", sha256: digestFile(archive) },
      serverRoot, { id: "linux-x64" },
      {
        run(command, args) {
          commands.push(command);
          if (command === "ldd") return { status: 0, stdout: "libmad.so.0 => not found" };
          if (args[0] === "--field") return { status: 0, stdout: "libmp3lame0 (>= 3.100), libmad0" };
          const staging = args[2];
          fs.mkdirSync(path.join(staging, "usr", "bin"), { recursive: true });
          fs.mkdirSync(path.join(staging, "usr", "share", "liquidsoap", "libs"), { recursive: true });
          fs.writeFileSync(path.join(staging, "usr", "bin", "liquidsoap"), "executable");
          fs.writeFileSync(path.join(staging, "usr", "share", "liquidsoap", "libs", "stdlib.liq"), "library");
          return { status: 0 };
        },
        validate: () => ({ ok: false, detail: "error while loading shared libraries: libmad.so.0" }),
      },
    ), /sudo apt-get --no-remove satisfy 'libmp3lame0 \(>= 3.100\), libmad0'/);
    assert.deepEqual(commands, ["dpkg-deb", "dpkg-deb", "ldd"]);
    assert.deepEqual(fs.readdirSync(path.join(serverRoot, "bin", "liquidsoap")), []);
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

test("missing FFmpeg reports an OS package command before downloads", () => {
  assert.throws(
    () => preflightInstall({
      runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" },
      existingBinary: { found: false, source: "missing" },
      debianFamily: true,
      osRelease: { distribution: "debian", codename: "bookworm" },
      dependencyStatus: {
        items: [
          { label: "Liquidsoap", found: false },
          { label: "FFmpeg", found: false },
        ],
        missing: ["liquidsoap", "ffmpeg"],
      },
      userId: 1000,
    }),
    /FFmpeg[\s\S]*sudo apt-get install ffmpeg/,
  );
});

test("Linux preflight does not require root when only Liquidsoap is missing", () => {
  assert.doesNotThrow(() => preflightInstall({
    runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" },
    existingBinary: { found: false, source: "missing" },
    debianFamily: true,
    osRelease: { distribution: "debian", codename: "bookworm" },
    dependencyStatus: { missing: ["liquidsoap"] },
    userId: 1000,
  }));
});

test("Ubuntu Jammy preflight tolerates an invalid local runtime manifest", (context) => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "radio-manifest-"));
  context.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  const manifest = path.join(serverRoot, "bin", "liquidsoap", "linux-x64", "runtime.json");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  for (const contents of ["null", "[]", "false", '"text"', "{broken"]) {
    fs.writeFileSync(manifest, contents);
    assert.doesNotThrow(() => preflightInstall({
      serverRoot,
      runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" },
      existingBinary: { found: false, source: "platform" },
      debianFamily: true,
      osRelease: { distribution: "ubuntu", codename: "jammy" },
      dependencyStatus: { missing: ["liquidsoap"] },
    }), contents);
  }
});

test("Linux update refreshes a dpkg-managed Liquidsoap installation", () => {
  const existing = { found: true, path: "/usr/bin/liquidsoap", source: "PATH" };
  assert.deepEqual(
    getLinuxInstallPlan({
      existing,
      force: true,
      missing: [],
      systemPackageInstalled: true,
    }),
    {
      externallyManagedLiquidsoap: false,
    },
  );
  assert.doesNotThrow(
    () => preflightInstall({
      runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" },
      existingBinary: existing,
      debianFamily: true,
      osRelease: { distribution: "ubuntu", codename: "noble" },
      dependencyStatus: { items: [], missing: [] },
      liquidsoapSystemPackage: true,
      force: true,
      userId: 1000,
    }),
  );
});

test("Linux update preserves an externally managed Liquidsoap installation", () => {
  assert.deepEqual(
    getLinuxInstallPlan({
      existing: { found: true, path: "/opt/opam/bin/liquidsoap", source: "PATH" },
      force: true,
      missing: [],
      systemPackageInstalled: false,
    }),
    {
      externallyManagedLiquidsoap: true,
    },
  );
});

for (const valid of [false, true]) {
  test(`locked cleanup directories ${valid ? "cannot turn activation into failure" : "cannot mask the extraction error"}`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-cleanup-test-"));
    const remove = fs.rmSync;
    context.after(() => remove(root, { recursive: true, force: true }));
    context.mock.method(console, "log", () => {});
    const warning = context.mock.method(console, "warn", () => {});
    const runtime = path.join(root, "bin", "liquidsoap", "linux-x64");
    const binary = path.join(runtime, "usr", "bin", "liquidsoap");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "previous runtime");
    const archive = path.join(root, "package.deb");
    fs.writeFileSync(archive, "test package");
    context.mock.method(fs, "rmSync", (target, options) => {
      if (String(target).includes("linux-x64.tmp-")) {
        assert.equal(options.maxRetries, 5);
        assert.equal(options.retryDelay, 100);
        throw Object.assign(new Error("directory is busy"), { code: "EPERM" });
      }
      return remove(target, options);
    });
    const install = () => extractLinuxPackage(
      { filePath: archive, fileName: "package.deb", sha256: digestFile(archive) },
      root, { family: "linux", architecture: "x64", id: "linux-x64" },
      {
        run(_command, args) {
          if (!valid) return { status: 1, error: new Error("TEST_EXTRACTION_DENIED") };
          const stagedBinary = path.join(args[2], "usr", "bin", "liquidsoap");
          const stdlib = path.join(args[2], "usr", "share", "liquidsoap", "libs", "stdlib.liq");
          fs.mkdirSync(path.dirname(stagedBinary), { recursive: true });
          fs.mkdirSync(path.dirname(stdlib), { recursive: true });
          fs.writeFileSync(stagedBinary, "new runtime");
          fs.writeFileSync(stdlib, "test library");
          return { status: 0 };
        },
        validate: () => ({ ok: true }),
      },
    );
    if (valid) assert.equal(install(), binary);
    else assert.throws(install, /Liquidsoap extraction failed: TEST_EXTRACTION_DENIED/);
    assert.equal(fs.readFileSync(binary, "utf8"), valid ? "new runtime" : "previous runtime");
    assert.ok(warning.mock.callCount() > 0);
  });
}

for (const family of ["macos", "freebsd"]) {
  test(`${family} refuses an unusable supplied Liquidsoap even when its file is in bin`, () => {
    assert.throws(() => preflightInstall({
      runtimeProfile: { family, architecture: "x64", id: `${family}-x64` },
      existingBinary: { found: true, source: "platform", path: "/provided/liquidsoap" },
      dependencyStatus: { missing: ["liquidsoap"] },
    }), /Supplied Liquidsoap failed validation/);
  });
  for (const source of ["platform", "PATH", "LIQUIDSOAP_BIN"]) {
    for (const force of [false, true]) {
      test(`${family} ${force ? "update" : "install"} preserves the supplied Liquidsoap from ${source}`, async (context) => {
        const profile = { family, architecture: "x64", id: `${family}-x64` };
        const existing = { found: true, source, path: "/provided/liquidsoap" };
        context.mock.method(console, "log", () => {});
        context.mock.method(require("../app/platform"), "resolveProfile", () => profile);
        context.mock.method(require("../app/platform"), "resolveLiquidsoapBinary", () => existing);
        context.mock.method(require("../app/download"), "downloadVerified", () => assert.fail("must not download a replacement"));
        assert.doesNotThrow(() => preflightInstall({
          runtimeProfile: profile, existingBinary: existing, dependencyStatus: { missing: [] },
        }));
        assert.equal(await installDependencies({ force }), existing.path);
      });
    }
  }
}

for (const distribution of ["ubuntu", "debian", "fedora", "arch", "alpine", "opensuse"]) {
  test(`Linux preflight accepts already-validated external runtimes without an Ubuntu package on ${distribution}`, () => {
    assert.doesNotThrow(() => preflightInstall({
      runtimeProfile: { family: "linux", architecture: "x64", id: "linux-x64" },
      existingBinary: { found: true, source: "LIQUIDSOAP_BIN", path: "/provided/liquidsoap" },
      dependencyStatus: { missing: [] },
      debianFamily: ["ubuntu", "debian"].includes(distribution),
      osRelease: { distribution, codename: "test-release" },
    }));
  });
}
