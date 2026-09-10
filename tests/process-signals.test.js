const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const state = require("../app/process-state");

function fixture(context, platform = "linux") {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  context.after(() => Object.defineProperty(process, "platform", descriptor));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = context.mock.fn(() => true);
  context.after(() => child.emit("close"));
  context.mock.timers.enable({ apis: ["setTimeout"] });
  return child;
}

for (const platform of ["linux", "darwin", "freebsd"]) {
  test(`terminal hangup stops the engine instead of forwarding SIGHUP on ${platform}`, (context) => {
    const child = fixture(context, platform);
    state.forwardSignals(child);
    process.emit("SIGHUP");
    assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [["SIGTERM"]]);
  });
}

for (const platform of ["linux", "win32"]) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`${signal} keeps its shutdown meaning on ${platform}`, (context) => {
      const child = fixture(context, platform);
      state.forwardSignals(child);
      process.emit(signal);
      assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [[signal]]);
    });
  }
}

test("repeated shutdown signals retain handlers and do not extend the grace period", (context) => {
  const child = fixture(context);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map((signal) => process.listenerCount(signal));
  state.forwardSignals(child, { timeoutMs: 100 });
  process.emit("SIGHUP");
  context.mock.timers.tick(50);
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.emit(signal);
  signals.forEach((signal, index) => assert.equal(process.listenerCount(signal), listeners[index] + 1));
  assert.equal(child.kill.mock.callCount(), 1);
  context.mock.timers.tick(50);
  assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [["SIGTERM"], ["SIGKILL"]]);
  child.signalCode = "SIGKILL";
  child.emit("exit");
  child.emit("close");
  signals.forEach((signal, index) => assert.equal(process.listenerCount(signal), listeners[index]));
});

test("normal shutdown cancels forced termination and waits for output to close", (context) => {
  const child = fixture(context);
  const initial = process.listenerCount("SIGHUP");
  state.forwardSignals(child, { timeoutMs: 100 });
  process.emit("SIGHUP");
  child.exitCode = 0;
  child.emit("exit");
  assert.equal(process.listenerCount("SIGHUP"), initial + 1);
  process.emit("SIGHUP");
  context.mock.timers.tick(200);
  assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [["SIGTERM"]]);
  child.emit("close");
  assert.equal(process.listenerCount("SIGHUP"), initial);
});

test("closing a failed spawn removes handlers and pending shutdown timers", (context) => {
  const child = fixture(context);
  const initial = process.listenerCount("SIGHUP");
  state.forwardSignals(child, { timeoutMs: 100 });
  process.emit("SIGHUP");
  child.emit("close", -1, null);
  context.mock.timers.tick(200);
  assert.equal(child.kill.mock.callCount(), 1);
  assert.equal(process.listenerCount("SIGHUP"), initial);
});

test("an engine that exits independently is never signaled", (context) => {
  const child = fixture(context);
  state.forwardSignals(child, { timeoutMs: 100 });
  child.exitCode = 1;
  child.emit("exit");
  process.emit("SIGHUP");
  context.mock.timers.tick(200);
  child.emit("close");
  assert.equal(child.kill.mock.callCount(), 0);
});

test("Windows does not register POSIX terminal hangup handlers", (context) => {
  const child = fixture(context, "win32");
  const initial = process.listenerCount("SIGHUP");
  state.forwardSignals(child);
  assert.equal(process.listenerCount("SIGHUP"), initial);
});

for (const destination of ["stdout", "stderr"]) {
  test(`a broken ${destination} stops the engine and releases only its own listeners`, (context) => {
    const child = fixture(context);
    const stream = process[destination];
    const initial = stream.listeners("error");
    const onOutputError = context.mock.fn();
    state.forwardSignals(child, { timeoutMs: 100, onOutputError });
    // Invoke only the controller's listener, without disrupting the test reporter
    const handler = stream.listeners("error").find((listener) => !initial.includes(listener));
    assert.equal(typeof handler, "function");
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    handler(error);
    handler(error);
    assert.equal(onOutputError.mock.callCount(), 1);
    assert.equal(onOutputError.mock.calls[0].arguments[0], error);
    context.mock.timers.tick(100);
    assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [["SIGTERM"], ["SIGKILL"]]);
    child.emit("close");
    assert.deepEqual(stream.listeners("error"), initial);
  });
}

for (const platform of ["linux", "darwin", "freebsd", "win32"]) {
  test(`internal shutdown has a bounded deadline on ${platform}`, (context) => {
    const child = fixture(context, platform);
    const shutdown = state.forwardSignals(child, { timeoutMs: 100 });
    shutdown();
    context.mock.timers.tick(50);
    shutdown();
    process.emit("SIGTERM");
    context.mock.timers.tick(50);
    assert.deepEqual(child.kill.mock.calls.map((call) => call.arguments), [["SIGTERM"], ["SIGKILL"]]);
    child.emit("close");
    shutdown();
    context.mock.timers.tick(200);
    assert.equal(child.kill.mock.callCount(), 2);
  });
}
