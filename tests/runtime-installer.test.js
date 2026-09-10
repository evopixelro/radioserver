const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const dependencies = require("../app/dependencies");
const platform = require("../app/platform");
const { installRuntime } = require("../app/runtime-installer");
const shoutcast = require("../app/shoutcast-package");

test("install refuses to replace runtimes while a managed process is running", async (context) => {
  const radio = require("../app/process-manager");
  context.mock.method(radio, "getStatus", () => ({ running: true, pid: 1234 }));
  const install = context.mock.method(shoutcast, "installShoutcast", () => assert.fail("must not download"));
  await assert.rejects(installRuntime({ acceptLicense: true }), /Stop SHOUTcast and AutoDJ/);
  assert.equal(install.mock.callCount(), 0);
});

test("runtime update refreshes SHOUTcast and Liquidsoap AutoDJ", async (context) => {
  const runtimeProfile = { family: "linux", architecture: "x64", id: "linux-x64" };
  const liquidsoap = { found: true, path: "/usr/bin/liquidsoap", source: "PATH" };
  const serverRoot = path.resolve("/srv/radioserver");

  context.mock.method(console, "log", () => {});
  context.mock.method(platform, "resolveProfile", () => runtimeProfile);
  context.mock.method(require("../app/system-dependencies"), "inspect", () => ({
    checked: true, missing: [], libraries: [], abiError: false,
  }));
  context.mock.method(platform, "resolveShoutcastBinary", () => ({
    found: true,
    path: "/srv/radioserver/bin/shoutcast/linux-x64/sc_serv",
  }));
  context.mock.method(dependencies, "getDependencyStatus", () => ({
    items: [
      { label: "Liquidsoap (AutoDJ)", found: true, detail: liquidsoap.path },
      { label: "FFmpeg", found: true, detail: "available on PATH" },
    ],
    liquidsoap,
    missing: [],
  }));
  const preflight = context.mock.method(dependencies, "preflightInstall", () => {});
  const updateShoutcast = context.mock.method(shoutcast, "installShoutcast", async () => {});
  const updateLiquidsoap = context.mock.method(dependencies, "installDependencies", async () => {});

  await installRuntime({ acceptLicense: true, force: true, serverRoot });

  assert.equal(preflight.mock.callCount(), 1);
  assert.deepEqual(updateShoutcast.mock.calls[0].arguments[0], {
    acceptLicense: true,
    force: true,
    serverRoot,
  });
  assert.deepEqual(updateLiquidsoap.mock.calls[0].arguments[0], {
    force: true,
    serverRoot,
  });
});

for (const source of ["SC_SERV_BIN", "LIQUIDSOAP_BIN"]) {
  for (const force of [false, true]) {
    test(`${force ? "update" : "install"} rejects a missing ${source} override before downloads`, async (context) => {
      context.mock.method(console, "log", () => {});
      context.mock.method(require("../app/process-manager"), "getStatus", () => ({ running: false }));
      context.mock.method(require("../app/autodj-manager"), "status", () => ({ running: false }));
      context.mock.method(platform, "resolveProfile", () => ({ family: "linux", architecture: "x64", id: "linux-x64" }));
      const shoutcastBinary = { found: false, path: "/missing/sc_serv", source: source === "SC_SERV_BIN" ? source : "platform" };
      const liquidsoap = { found: false, path: "/missing/liquidsoap", source: source === "LIQUIDSOAP_BIN" ? source : "platform" };
      context.mock.method(platform, "resolveShoutcastBinary", () => shoutcastBinary);
      context.mock.method(dependencies, "getDependencyStatus", () => ({ liquidsoap, items: [], missing: ["liquidsoap"] }));
      context.mock.method(dependencies, "preflightInstall", () => {});
      const radioInstall = context.mock.method(shoutcast, "installShoutcast", async () => {});
      const autodjInstall = context.mock.method(dependencies, "installDependencies", async () => {});
      await assert.rejects(installRuntime({ acceptLicense: true, force }), new RegExp(`${source}.*Correct.*unset`));
      assert.equal(radioInstall.mock.callCount(), 0);
      assert.equal(autodjInstall.mock.callCount(), 0);
    });
  }
}

function platformFixture(context, family, architecture, shoutcastFound) {
  const profile = { family, architecture, id: `${family}-${architecture}` };
  context.mock.method(console, "log", () => {});
  context.mock.method(require("../app/process-manager"), "getStatus", () => ({ running: false }));
  context.mock.method(require("../app/autodj-manager"), "status", () => ({ running: false }));
  context.mock.method(platform, "resolveProfile", () => profile);
  context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: shoutcastFound, path: "/provided/sc_serv", source: shoutcastFound ? "PATH" : "missing" }));
  context.mock.method(require("../app/system-dependencies"), "inspect", () => ({ checked: true, missing: [], libraries: [], abiError: false }));
  context.mock.method(dependencies, "getDependencyStatus", () => ({
    liquidsoap: { found: true, path: "/provided/liquidsoap", source: "PATH" }, items: [], missing: [],
  }));
  return {
    preflight: context.mock.method(dependencies, "preflightInstall", () => {}),
    radio: context.mock.method(shoutcast, "installShoutcast", async () => {}),
    autodj: context.mock.method(dependencies, "installDependencies", async () => {}),
  };
}

for (const family of ["linux", "windows", "macos", "freebsd"]) {
  test(`complete runtime installation accepts validated supplied binaries on ${family}`, async (context) => {
    const fixture = platformFixture(context, family, "x64", true);
    await installRuntime({ acceptLicense: true });
    assert.equal(fixture.preflight.mock.callCount(), 1);
    assert.equal(fixture.radio.mock.callCount(), 1);
    assert.equal(fixture.autodj.mock.callCount(), 1);
  });
}

for (const force of [false, true]) {
  test(`Windows ${force ? "update" : "install"} repairs a damaged managed SHOUTcast package`, async (context) => {
    const fixture = platformFixture(context, "windows", "x64", true);
    context.mock.method(platform, "resolveShoutcastBinary", () => ({ found: true, path: "/managed/sc_serv.exe", source: "platform" }));
    context.mock.method(require("../app/system-dependencies"), "inspect", () => ({
      checked: false, libraries: [], missing: [], abiError: false, inspectionError: "Invalid PE header",
    }));
    await installRuntime({ acceptLicense: true, force });
    assert.equal(fixture.preflight.mock.callCount(), 1);
    assert.equal(fixture.radio.mock.calls[0].arguments[0].force, true);
    assert.equal(fixture.autodj.mock.callCount(), 1);
  });
}

for (const family of ["linux", "windows", "macos", "freebsd"]) {
  for (const force of [false, true]) {
    test(`${family} ${force ? "update" : "install"} stops before downloads when native inspection fails`, async (context) => {
      const fixture = platformFixture(context, family, "x64", true);
      context.mock.method(require("../app/system-dependencies"), "inspect", () => ({
        checked: false, libraries: [], missing: [], abiError: false, inspectionError: "OS inspection tool failed",
      }));
      await assert.rejects(installRuntime({ acceptLicense: true, force }), { code: "RADIO_NATIVE_INSPECTION" });
      assert.equal(fixture.preflight.mock.callCount(), 0);
      assert.equal(fixture.radio.mock.callCount(), 0);
      assert.equal(fixture.autodj.mock.callCount(), 0);
    });
  }
}

for (const [family, architecture] of [["macos", "x64"], ["macos", "arm64"], ["freebsd", "x64"], ["freebsd", "arm64"], ["linux", "arm64"], ["windows", "arm64"]]) {
  test(`${family}-${architecture} cannot install AutoDJ alone when SHOUTcast has no available binary`, async (context) => {
    const fixture = platformFixture(context, family, architecture, false);
    await assert.rejects(installRuntime({ acceptLicense: true }), /No current official SHOUTcast package.*complete radio stack/);
    assert.equal(fixture.preflight.mock.callCount(), 0);
    assert.equal(fixture.radio.mock.callCount(), 0);
    assert.equal(fixture.autodj.mock.callCount(), 0);
  });
}
