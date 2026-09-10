const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { isAutomaticNpmInstall } = require("../app/cli");
const cli = require("../app/cli");
const runtimeInstaller = require("../app/runtime-installer");
const codeUpdater = require("../app/code-updater");
const { printRuntimeStatus } = require("../app/runtime-installer");

const serverPath = path.join(__dirname, "..", "server.js");

test("normal npm install lifecycle never downloads radio runtimes", () => {
  const result = spawnSync(process.execPath, [serverPath, "install", "--accept-license"], {
    encoding: "utf8",
    env: {
      ...process.env,
      npm_command: "ci",
      npm_lifecycle_event: "install",
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /npm run install/);
});

test("recognizes explicit npm run install across npm versions", () => {
  for (const npmCommand of ["run", "run-script"]) {
    assert.equal(
      isAutomaticNpmInstall({
        npm_command: npmCommand,
        npm_lifecycle_event: "install",
      }),
      false,
      npmCommand,
    );
  }
  assert.equal(
    isAutomaticNpmInstall({
      npm_config_argv: JSON.stringify({ original: ["run", "install"] }),
      npm_lifecycle_event: "install",
    }),
    false,
  );
});

test("all npm install commands include license acceptance", () => {
  const packageConfig = require("../package.json");
  const installScripts = Object.entries(packageConfig.scripts)
    .filter(([name]) => name === "install" || name.startsWith("install:"));

  assert.deepEqual(
    installScripts.map(([name]) => name),
    [
      "install",
      "install:linux",
      "install:windows",
      "install:windows:x86",
      "install:macos",
      "install:freebsd",
    ],
  );
  for (const [name, command] of installScripts) {
    assert.match(command, /(?:^| )--accept-license(?: |$)/, name);
  }
});

test("all npm update commands refresh licensed runtimes", () => {
  const packageConfig = require("../package.json");
  const updateScripts = Object.entries(packageConfig.scripts)
    .filter(([name]) => name === "update" || name.startsWith("update:"));

  assert.deepEqual(
    updateScripts.map(([name]) => name),
    [
      "update",
      "update:linux",
      "update:windows",
      "update:windows:x86",
      "update:macos",
      "update:freebsd",
    ],
  );
  for (const [name, command] of updateScripts) {
    assert.match(command, /(?:^| )--accept-license(?: |$)/, name);
  }
});

test("code update is separate from runtime updates and forwards its options", async (context) => {
  assert.equal(require("../package.json").scripts["code:update"], "node server.js update_code");
  const calls = context.mock.method(codeUpdater, "updateCode", async () => {});
  for (const args of [[], ["--check"], ["--force"], ["--rollback"]]) {
    await cli.main(["update_code", ...args]);
    assert.deepEqual(calls.mock.calls.at(-1).arguments[1], args);
  }
  await assert.rejects(cli.main(["update_code", "--wrong"]), /Usage/);
});

test("install and update forward explicit license acceptance to the runtime installer", async (context) => {
  const installer = context.mock.method(runtimeInstaller, "installRuntime", async () => {});
  await cli.main(["install", "--accept-license"]);
  await cli.main(["update", "--accept-license"]);
  assert.deepEqual(installer.mock.calls.map((call) => call.arguments[0]), [
    { acceptLicense: true },
    { acceptLicense: true, force: true },
  ]);
});

test("every platform install and update script forwards its acceptance flag", async (context) => {
  const { run } = require("../app/platform-runner");
  const main = context.mock.method(cli, "main", async () => {});
  const previousPlatform = process.env.RADIO_PLATFORM;
  try {
    for (const command of Object.values(require("../package.json").scripts)) {
      if (!command.includes("app/platform-runner.js") || !command.includes("--accept-license")) continue;
      const args = command.split(" ").slice(2);
      await run(args);
      assert.equal(process.env.RADIO_PLATFORM, args[0]);
      assert.deepEqual(main.mock.calls.at(-1).arguments, [[args[2], "--accept-license"]]);
    }
    assert.equal(main.mock.callCount(), 10);
  } finally {
    if (previousPlatform === undefined) delete process.env.RADIO_PLATFORM;
    else process.env.RADIO_PLATFORM = previousPlatform;
  }
});

test("runtime status renders found and missing requirements with colors", (context) => {
  const lines = [];
  context.mock.method(console, "log", (line) => lines.push(line));
  printRuntimeStatus({
    runtimeProfile: { id: "linux-x64" },
    items: [
      { label: "Node.js", found: true, detail: "v22.0.0" },
      { label: "Liquidsoap", found: false, detail: "not found" },
    ],
  }, { color: true });

  const output = lines.join("\n");
  assert.match(output, /\u001b\[32mFOUND\u001b\[0m Node\.js/);
  assert.match(output, /\u001b\[31mMISSING\u001b\[0m Liquidsoap/);
});

test("direct commands without a flag rely on saved consent instead of implying acceptance", async (context) => {
  const installer = context.mock.method(runtimeInstaller, "installRuntime", async () => {});
  await cli.main(["install"]);
  await cli.main(["update"]);
  assert.deepEqual(installer.mock.calls.map((call) => call.arguments[0]), [
    { acceptLicense: false },
    { acceptLicense: false, force: true },
  ]);
});

test("console npm scripts use their matching component without Screen", () => {
  const scripts = require("../package.json").scripts;
  assert.equal(scripts.console, "node server.js console");
  assert.equal(scripts["autodj:console"], "node autodj.js console");
  assert.equal(scripts["logs:clear"], "node server.js clear_logs");
  assert.equal(scripts["autodj:logs:clear"], "node autodj.js clear_logs");
});

test("platform runner routes the AutoDJ console to AutoDJ instead of SHOUTcast", async (context) => {
  const { run } = require("../app/platform-runner");
  const main = context.mock.method(cli, "main", async () => {});
  const previousPlatform = process.env.RADIO_PLATFORM;
  try {
    await run(["auto", "autodj", "console"]);
    assert.deepEqual(main.mock.calls.at(-1).arguments, [["console_autodj"]]);
  } finally {
    if (previousPlatform === undefined) delete process.env.RADIO_PLATFORM;
    else process.env.RADIO_PLATFORM = previousPlatform;
  }
});

for (const setting of ["SC_LOG_MAX_SIZE_MB", "SC_LOG_MAX_FILES", "SC_SERV_ARGS_JSON"]) {
  test(`invalid ${setting} cannot block AutoDJ or stop commands`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "radio-config-isolation-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ["-e", `
const cli = require('./app/cli');
const radio = require('./app/process-manager');
const autodj = require('./app/autodj-manager');
require('./app/process-state').inspect = pid => pid === process.pid ? { fingerprint: 'config-isolation-test' } : null;
for (const method of ['start', 'runForeground', 'stop']) autodj[method] = async () => console.log('AutoDJ ' + method);
autodj.prepareRuntime = () => {};
autodj.status = () => ({ running: false });
radio.stop = async () => console.log('Radio stop');
require('./app/log-console').followLogs = async () => console.log('Console reached');
(async () => {
  for (const command of ['help', 'start_autodj', 'run_autodj', 'stop_autodj', 'autodj-restart', 'autodj-status', 'console_autodj', 'clear_logs_autodj', 'stop']) await cli.main([command]);
  require('node:assert/strict').throws(() => radio.getRunConfig(require('./app/config')), /${setting}/);
  process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 20000, windowsHide: true,
      env: { ...process.env, [setting]: "invalid", RADIO_RUN_DIR: root, RADIO_LOG_DIR: root, SC_SERV_CONFIG: path.join(root, "sc_serv.conf") } });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /AutoDJ start/);
    assert.match(result.stdout, /AutoDJ runForeground/);
    assert.match(result.stdout, /Console reached/);
    assert.match(result.stdout, /Radio stop/);
  });
}

test("invalid SHOUTcast restart options cannot stop the existing server", async (context) => {
  const previous = process.env.SC_LOG_MAX_FILES;
  process.env.SC_LOG_MAX_FILES = "invalid";
  context.after(() => { if (previous === undefined) delete process.env.SC_LOG_MAX_FILES; else process.env.SC_LOG_MAX_FILES = previous; });
  const stop = context.mock.method(require("../app/process-manager"), "stop", async () => {});
  await assert.rejects(cli.main(["restart"]), /SC_LOG_MAX_FILES/);
  assert.equal(stop.mock.callCount(), 0);
});

test("null characters in configured SHOUTcast arguments cannot stop a running server on restart", async (context) => {
  const previous = process.env.SC_SERV_ARGS_JSON;
  process.env.SC_SERV_ARGS_JSON = JSON.stringify(["value\0suffix"]);
  context.after(() => { if (previous === undefined) delete process.env.SC_SERV_ARGS_JSON; else process.env.SC_SERV_ARGS_JSON = previous; });
  const stop = context.mock.method(require("../app/process-manager"), "stop", async () => {});
  await assert.rejects(cli.main(["restart"]), /SC_SERV_ARGS_JSON.*null characters/);
  assert.equal(stop.mock.callCount(), 0);
});

for (const [command, moduleName] of [["restart", "process-manager"], ["autodj-restart", "autodj-manager"]]) {
  test(`${command} validates before stopping and preserves the service when validation fails`, async (context) => {
    const manager = require(`../app/${moduleName}`);
    const events = [];
    context.mock.method(manager, "stop", async () => events.push("stop"));
    context.mock.method(manager, "start", async () => events.push("start"));
    const validate = context.mock.method(manager, "prepareRuntime", () => { events.push("validate"); throw new Error("invalid active configuration"); });
    await assert.rejects(cli.main([command]), /invalid active configuration/);
    assert.deepEqual(events, ["validate"]);
    events.length = 0;
    validate.mock.mockImplementation((config) => { events.push("validate"); return config; });
    await cli.main([command]);
    assert.deepEqual(events, ["validate", "stop", "start"]);
    if (moduleName === "autodj-manager") assert.deepEqual(validate.mock.calls.at(-1).arguments[1], { validationOnly: true });
  });
}

test("unsupported Node.js blocks launches and mutations before obtaining a controller lock", async (context) => {
  context.mock.method(require("../app/doctor"), "versionIsSupported", () => false);
  const inspect = context.mock.method(require("../app/process-state"), "inspect", () => { throw new Error("lock must not be reached"); });
  for (const command of ["start", "run", "restart", "start_autodj", "run_autodj", "autodj-restart", "install", "update", "update_code", "playlist", "setup", "clear_logs"]) {
    await assert.rejects(cli.main([command]), /Node\.js >=22\.0\.0 is required/);
  }
  assert.equal(inspect.mock.callCount(), 0);
});

test("unsupported Node.js still permits stopping an existing service", async (context) => {
  context.mock.method(require("../app/doctor"), "versionIsSupported", () => false);
  const stop = context.mock.method(require("../app/process-manager"), "stop", async () => {});
  await cli.main(["stop"]);
  assert.equal(stop.mock.callCount(), 1);
});

test("AutoDJ help identifies its own entrypoint and default foreground mode", () => {
  for (const args of [["autodj.js", "--help"], ["app/platform-runner.js", "auto", "autodj", "help"]]) {
    const result = spawnSync(process.execPath, args, {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: node autodj\.js/);
    assert.match(result.stdout, /no command.*foreground/i);
    for (const command of ["start", "stop", "restart", "status", "console", "clear_logs"]) {
      assert.match(result.stdout, new RegExp(`^  ${command}(?: |$)`, "m"));
    }
  }
});

test("server help uses aligned descriptions across every section", async (context) => {
  const lines = [];
  context.mock.method(console, "log", (text) => lines.push(...text.split("\n")));
  await cli.main(["help"]);
  const columns = lines.flatMap((line) => {
    const match = /^  \S.*? {2,}(\S.*)$/.exec(line);
    return match ? [line.length - match[1].length] : [];
  });
  assert.ok(columns.length >= 10);
  assert.equal(new Set(columns).size, 1);
});

for (const [component, expected] of [["server", "run"], ["autodj", "run_autodj"]]) {
  test(`${component} entrypoint uses the same foreground default when imported`, async (context) => {
    const main = context.mock.method(cli, "main", async () => {});
    const entrypoint = require(`../${component}`);
    await entrypoint.main([]);
    await entrypoint.main(["run", "--example-option"]);
    assert.deepEqual(main.mock.calls.map((call) => call.arguments), [
      [[expected]],
      [[expected, "--example-option"]],
    ]);
  });
}

for (const selection of ["linux", "windows", "macos", "freebsd"]) {
  test(`${selection} AutoDJ commands share the direct entrypoint routing`, async (context) => {
    const main = context.mock.method(cli, "main", async () => {});
    const entrypoint = require("../autodj");
    const { run } = require("../app/platform-runner");
    const previousPlatform = process.env.RADIO_PLATFORM;
    context.after(() => {
      if (previousPlatform === undefined) delete process.env.RADIO_PLATFORM;
      else process.env.RADIO_PLATFORM = previousPlatform;
    });

    for (const [command, expected] of [
      ["start", "start_autodj"],
      ["stop", "stop_autodj"],
      ["restart", "autodj-restart"],
      ["status", "autodj-status"],
      ["console", "console_autodj"],
      ["clear_logs", "clear_logs_autodj"],
      ["run", "run_autodj"],
      ["run_autodj", "run_autodj"],
    ]) {
      const argumentsList = [command, "argument with spaces"];
      await entrypoint.main(argumentsList);
      await run([selection, "autodj", ...argumentsList]);
      assert.equal(process.env.RADIO_PLATFORM, selection);
      assert.deepEqual(main.mock.calls.at(-2).arguments, [[expected, "argument with spaces"]]);
      assert.deepEqual(main.mock.calls.at(-1).arguments, main.mock.calls.at(-2).arguments);
      assert.deepEqual(argumentsList, [command, "argument with spaces"]);
    }
  });
}
