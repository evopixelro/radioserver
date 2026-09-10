const assert = require("node:assert/strict");
const test = require("node:test");
const native = require("../app/system-dependencies");
const dependencies = require("../app/dependencies");

test("ldd reports missing libraries separately from resolved dependencies", () => {
  const report = native.inspect("/radio/liquidsoap", { family: "linux", architecture: "x64" }, {
    run: () => ({ status: 0, stdout: "libtag.so.1 => not found\nlibc.so.6 => /lib/libc.so.6 (0x1)\nlibmad.so.0 => not found" }),
  });
  assert.deepEqual(report.missing, ["libtag.so.1", "libmad.so.0"]);
  assert.equal(report.libraries[1].found, true);
  assert.equal(native.statusItems("AutoDJ", report).length, 2);
});

test("missing TagLib stops Linux preflight before downloads and requests only OS packages", () => {
  assert.throws(() => dependencies.preflightInstall({
    runtimeProfile: { family: "linux", architecture: "x64" }, debianFamily: true,
    existingBinary: { found: true, source: "platform" },
    dependencyStatus: { missing: ["liquidsoap"], nativeLibraries: { missing: ["libtag.so.1"], architecture: "x64" } },
  }), (error) => {
    // Use the explicit distribution for host-independent command checks below
    assert.equal(error.code, "RADIO_OS_DEPENDENCIES");
    assert.match(error.message, /libtag.so.1/);
    assert.doesNotMatch(error.message, /sudo npm|install liquidsoap/);
    return true;
  });
  assert.match(native.installationHelp({ family: "linux" }, { distribution: "ubuntu", missing: ["libtag.so.1"] }), /sudo apt-get install libtag1v5/);
});

test("macOS uses Homebrew without sudo and warns about incompatible library versions", () => {
  const help = native.installationHelp({ family: "macos" }, { ffmpeg: true, missing: ["/opt/homebrew/opt/taglib/lib/libtag.1.dylib"] });
  assert.match(help, /brew install ffmpeg taglib/);
  assert.match(help, /must not run as root/);
  assert.match(help, /newer ABI cannot repair/);
  assert.doesNotMatch(help, /sudo/);
});

test("FreeBSD uses root pkg commands and RPM Linux uses exact soname capabilities", () => {
  assert.match(native.installationHelp({ family: "freebsd" }, { ffmpeg: true, missing: ["libtag.so.2"] }), /Run as root:\npkg install ffmpeg taglib/);
  assert.match(native.installationHelp({ family: "linux", architecture: "x64" }, { distribution: "fedora", missing: ["libtag.so.1"] }), /sudo dnf install 'libtag.so.1\(\)\(64bit\)'/);
});

test("Windows only requests Visual C++ when a corresponding DLL is missing", () => {
  const help = native.installationHelp({ family: "windows", architecture: "x86" }, { missing: ["VCRUNTIME140.dll"] });
  assert.match(help, /Administrator terminal/);
  assert.match(help, /winget install --exact --id Microsoft.VCRedist.2015\+.x86/);
  const bundled = native.installationHelp({ family: "windows", architecture: "x64" }, { missing: ["avcodec-61.dll"] });
  assert.match(bundled, /npm run update as your normal user/);
  assert.doesNotMatch(bundled, /Administrator terminal|winget|sudo/);
});

test("diagnostic errors preserve macOS, FreeBSD and Windows library names", () => {
  assert.deepEqual(native.missingFromError('dyld: Library not loaded: /usr/local/opt/taglib/lib/libtag.2.dylib'), ['/usr/local/opt/taglib/lib/libtag.2.dylib']);
  assert.deepEqual(native.missingFromError('ld-elf.so.1: Shared object "libtag.so.2" not found'), ['libtag.so.2']);
  assert.deepEqual(native.missingFromError('MSVCP140.dll was not found'), ['MSVCP140.dll']);
});

test("macOS inspection ignores system libraries in the dyld cache", () => {
  const report = native.inspect('/radio/liquidsoap', { family: 'macos' }, {
    run: () => ({ status: 0, stdout: '/radio/liquidsoap:\n /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n /opt/homebrew/opt/taglib/lib/libtag.2.dylib (compatibility version 2.0.0)' }),
    exists: () => false,
  });
  assert.deepEqual(report.missing, ['/opt/homebrew/opt/taglib/lib/libtag.2.dylib']);
});

test("macOS resolves rpaths, loader paths and executable symlinks without hiding missing libraries", () => {
  const probes = [];
  const report = native.inspect('/opt/bin/liquidsoap', { family: 'macos' }, {
    realpath: () => '/opt/Radio Runtime/bin/liquidsoap',
    run: (command, args) => {
      assert.equal(command, 'otool');
      assert.equal(args[1], '/opt/bin/liquidsoap');
      return { status: 0, stdout: args[0] === '-L'
        ? '/opt/bin/liquidsoap:\n @rpath/libtag.2.dylib (compatibility version 2.0.0)\n @rpath/libmissing.dylib (compatibility version 1.0.0)\n @loader_path/../lib/libcurl.dylib (compatibility version 1.0.0)\n @executable_path/../lib/libavcodec.dylib (compatibility version 1.0.0)'
        : '/opt/bin/liquidsoap:\nLoad command 1\n cmd LC_RPATH\n cmdsize 48\n path @loader_path/../lib (offset 12)\nLoad command 2\n cmd LC_RPATH\n cmdsize 48\n path /opt/Other Libraries/lib (offset 12)' };
    },
    exists: (file) => {
      probes.push(file);
      return ['/opt/Other Libraries/lib/libtag.2.dylib', '/opt/Radio Runtime/lib/libcurl.dylib', '/opt/Radio Runtime/lib/libavcodec.dylib'].includes(file);
    },
  });
  assert.equal(report.checked, true);
  assert.deepEqual(report.missing, ['@rpath/libmissing.dylib']);
  assert.ok(probes.includes('/opt/Radio Runtime/lib/libtag.2.dylib'));
  assert.ok(probes.includes('/opt/Other Libraries/lib/libtag.2.dylib'));
});

test("macOS does not silently accept an rpath dependency without a search path", () => {
  const report = native.inspect('/radio/sc_serv', { family: 'macos' }, {
    run: (_command, args) => ({ status: 0, stdout: args[0] === '-L'
      ? '/radio/sc_serv:\n @rpath/libtag.2.dylib (compatibility version 2.0.0)' : '/radio/sc_serv:\n' }),
    exists: () => false,
  });
  assert.deepEqual(report.missing, ['@rpath/libtag.2.dylib']);
  assert.throws(() => native.assertAvailable('SHOUTcast', { family: 'macos' }, report), { code: 'RADIO_OS_DEPENDENCIES' });
});

for (const architecture of ['x64', 'arm64']) {
  test(`macOS universal binaries do not mix ${architecture} dependencies with another architecture`, () => {
    const prefix = architecture === 'x64' ? '/usr/local' : '/opt/homebrew';
    const report = native.inspect('/radio/liquidsoap', { family: 'macos', architecture }, {
      run: (_command, args) => ({ status: 0, stdout: args[0] === '-L'
        ? '/radio/liquidsoap (architecture x86_64):\n @rpath/libtag.dylib (compatibility version 1.0.0)\n/radio/liquidsoap (architecture arm64):\n @rpath/libtag.dylib (compatibility version 1.0.0)'
        : '/radio/liquidsoap (architecture x86_64):\n cmd LC_RPATH\n cmdsize 40\n path /usr/local/lib (offset 12)\n/radio/liquidsoap (architecture arm64):\n cmd LC_RPATH\n cmdsize 40\n path /opt/homebrew/lib (offset 12)' }),
      exists: (file) => file !== `${prefix}/lib/libtag.dylib`,
    });
    assert.equal(report.checked, true);
    assert.equal(report.architecture, architecture);
    assert.deepEqual(report.missing, ['@rpath/libtag.dylib']);
    assert.equal(report.libraries.length, 1);
  });
}

test("macOS rejects an unsupported universal architecture without reporting a successful empty inspection", () => {
  const report = native.inspect('/radio/sc_serv', { family: 'macos', architecture: 'arm64' }, {
    run: () => ({ status: 0, stdout: '/radio/sc_serv (architecture i386):\n /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)' }),
  });
  assert.equal(report.checked, false);
  assert.ok(report.inspectionError);
});

test("macOS normalizes cache paths and rpaths before checking dependencies", () => {
  const report = native.inspect('/radio/sc_serv', { family: 'macos' }, {
    run: (_command, args) => ({ status: 0, stdout: args[0] === '-L'
      ? '/radio/sc_serv:\n @rpath/libSystem.B.dylib (compatibility version 1.0.0)\n /usr/lib/../../missing.dylib (compatibility version 1.0.0)'
      : '/radio/sc_serv:\n cmd LC_RPATH\n cmdsize 32\n path /usr/lib (offset 12)' }),
    exists: () => false,
  });
  assert.deepEqual(report.missing, ['/usr/lib/../../missing.dylib']);
});

for (const family of ['macos', 'freebsd', 'linux', 'windows']) {
  test(`${family} cannot pass native inspection when its OS tool fails`, () => {
    const report = native.inspect('/radio/sc_serv', { family }, {
      run: () => ({ error: new Error('tool unavailable'), status: null, stdout: '', stderr: '' }),
      readFile: () => Buffer.from('not an executable'),
    });
    assert.equal(report.checked, false);
    assert.equal(native.statusItems('SHOUTcast', report)[0].found, false);
    assert.throws(() => native.assertAvailable('SHOUTcast', { family }, report), { code: 'RADIO_NATIVE_INSPECTION' });
  });
}

test("macOS propagates architecture diagnostics and load-command inspection failures", () => {
  const incompatible = native.inspect('/radio/sc_serv', { family: 'macos' }, {
    run: () => ({ status: 1, stderr: 'Bad CPU type in executable' }),
  });
  assert.equal(incompatible.abiError, true);
  const invalid = native.inspect('/radio/sc_serv', { family: 'macos' }, {
    run: () => ({ status: 0, stdout: '/radio/sc_serv: is not an object file' }),
  });
  assert.equal(invalid.checked, false);
  const incomplete = native.inspect('/radio/sc_serv', { family: 'macos' }, {
    run: (_command, args) => args[0] === '-L'
      ? { status: 0, stdout: '/radio/sc_serv:\n @rpath/libtag.2.dylib (compatibility version 2.0.0)' }
      : { status: 1, stderr: 'cannot read load commands' },
  });
  assert.equal(incomplete.checked, false);
  assert.match(incomplete.inspectionError, /cannot read load commands/);
});

test("FreeBSD ldd reports resolved and missing ELF libraries", () => {
  const report = native.inspect('/radio/liquidsoap', { family: 'freebsd', architecture: 'x64' }, {
    run: (command, args) => {
      assert.equal(command, 'ldd');
      assert.deepEqual(args, ['/radio/liquidsoap']);
      return { status: 1, stdout: '/radio/liquidsoap:\n libtag.so.2 => not found (0)\n libc.so.7 => /lib/libc.so.7 (0x800)' };
    },
  });
  assert.equal(report.checked, true);
  assert.deepEqual(report.missing, ['libtag.so.2']);
});

for (const family of ["linux", "freebsd"]) {
  test(`${family} accepts a static ELF header but does not mistake text or a foreign binary for one`, () => {
    const executable = Buffer.alloc(64);
    executable.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    executable.writeUInt16LE(2, 16);
    executable.writeUInt16LE(62, 18);
    executable.writeUInt32LE(1, 20);
    const run = () => ({ status: 1, stderr: "not a dynamic executable" });
    for (const [architecture, machine, bits] of [["x64", 62, 2], ["x86", 3, 1], ["arm64", 183, 2], ["arm", 40, 1]]) {
      executable[4] = bits;
      executable.writeUInt16LE(machine, 18);
      const report = native.inspect("/radio/sc_serv", { family, architecture }, { run, readFile: () => executable });
      assert.equal(report.checked, true);
      assert.equal(report.architecture, architecture);
    }
    const object = Buffer.from(executable);
    object.writeUInt16LE(1, 16);
    for (const invalid of [Buffer.from("plain text"), Buffer.from("MZ"), object]) {
      const failed = native.inspect("/radio/sc_serv", { family }, { run, readFile: () => invalid });
      assert.equal(failed.checked, false);
      assert.throws(() => native.assertAvailable("SHOUTcast", { family }, failed), { code: "RADIO_NATIVE_INSPECTION" });
    }
  });
}

test("untrusted dependency names cannot introduce shell commands", () => {
  const help = native.installationHelp({ family: 'linux' }, { distribution: 'ubuntu', missing: ['libevil;whoami.so'], debianDepends: "libtag1v5'\nwhoami" });
  assert.doesNotMatch(help, /^sudo /m);
});

test("PE import parser rejects malformed files without executing them", () => {
  assert.equal(native.windowsImports(Buffer.from('not a PE')), null);
  assert.equal(native.windowsImports(Buffer.from('MZ')), null);
});

test("PE inspection rejects unknown machines and conflicting bitness", () => {
  const data = Buffer.alloc(512);
  data.write('MZ');
  data.writeUInt32LE(64, 0x3c);
  data.writeUInt32LE(0x4550, 64);
  data.writeUInt16LE(0x8664, 68);
  data.writeUInt16LE(0x20b, 88);
  assert.equal(native.windowsImports(data).architecture, 'x64');
  data.writeUInt16LE(0x200, 68);
  assert.equal(native.windowsImports(data), null);
  data.writeUInt16LE(0x14c, 68);
  assert.equal(native.windowsImports(data), null);
});

test("OS install commands are yellow in a terminal and plain when color is disabled", () => {
  const options = { distribution: "ubuntu", missing: ["libtag.so.1"] };
  const colored = native.installationHelp({ family: "linux" }, { ...options, color: true });
  assert.match(colored, /\u001b\[33msudo apt-get install libtag1v5\u001b\[0m/);
  const plain = native.installationHelp({ family: "linux" }, { ...options, color: false });
  assert.doesNotMatch(plain, /\u001b\[/);
});
