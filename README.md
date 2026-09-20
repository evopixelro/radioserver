# RadioServer

RadioServer runs SHOUTcast DNAS with Liquidsoap for AutoDJ. It provides commands
for installation, playback, playlist scheduling, metadata and log management.

## Requirements

- Node.js `>=22.0.0`; use a maintained LTS release with current security patches
- A compatible SHOUTcast DNAS executable; see the platform notes below
- Liquidsoap >=2.2.5 (>=2.4.5 for playlist schedules) with FFmpeg support and the configured audio codecs
- FFmpeg on Linux, macOS and FreeBSD; included in the managed Windows Liquidsoap package
- A dedicated service account with write access to the repository and its data directories

Run commands from the repository root as the service account. Use elevated
privileges only to install system dependencies. Startup and maintenance require
Node.js 22 or newer; help, diagnostics, status, console and stop commands remain
available on older versions for recovery.

### Platforms

| Platform | Runtime installation |
| --- | --- |
| Linux | Official SHOUTcast x64/x86 packages; Liquidsoap from an official package or a private OPAM build |
| Windows | Official SHOUTcast x64/x86 installer; Liquidsoap x64 portable package |
| FreeBSD x64 | Linux x64 SHOUTcast through Linuxulator; native Liquidsoap built with OPAM |
| macOS | Native Node.js, Liquidsoap and FFmpeg; no current native SHOUTcast package |
| Other FreeBSD architectures | Requires a compatible SHOUTcast executable supplied separately |

The installer selects Debian/Ubuntu packages for the exact distribution release
and architecture. Unix systems without a matching package build Liquidsoap from
source. Native 32-bit Windows requires a compatible Liquidsoap build supplied
separately.

[Current SHOUTcast server downloads](https://shoutcast.com/pricing/basic) target
Linux and Windows. FreeBSD x64 can use the Linux executable after Linuxulator is
configured. It is not a native FreeBSD build, and the installer does not enable
Linuxulator itself. On macOS, run the complete radio in a Linux virtual machine
with a compatible CPU architecture. The same applies to FreeBSD architectures
without a compatible DNAS binary. Older Mac/BSD DNAS builds are not downloaded
automatically.

## Installation

Read the [SHOUTcast DNAS license](https://www.shoutcast.com/legal/agreements/dnas)
before installing. The npm `install` and `update` scripts include
`--accept-license`; acceptance is saved in `bin/shoutcast/license.json`.

```bash
npm install
npm run install
```

`npm install` does not install the radio runtimes. Use `npm run install` to install
or reinstall them in `bin/`. This includes Liquidsoap's standard library and local
FFmpeg. Executables selected through `SC_SERV_BIN` or `LIQUIDSOAP_BIN` are checked,
not replaced. Active configurations stay in the repository root.

During install and update, system dependencies appear above the runtime list.
SHOUTcast and Liquidsoap have separate library checks. `FOUND` is green,
`MISSING` is red, and suggested OS installation commands are yellow. Run those
commands separately, then retry as the service account. RadioServer does not
install OS packages. Colors are disabled for redirected output and `NO_COLOR`.

Library checks are marked `NOT CHECKED` until the executable has been downloaded
or supplied. Its libraries are checked before activation. Archive tools are listed
separately; source builds also list compiler tools, development libraries and
version requirements. Package installation commands are shown where a mapping
is known. Libraries outside the system paths must be visible to `pkg-config`.
Official binary packages do not require the source-build tools.

Unix installations build the latest supported stable FFmpeg release in
`bin/ffmpeg/<os>-<arch>/` from signed sources at ffmpeg.org. The system FFmpeg is
left unchanged. `update` reuses a working local build when it is current;
`install` rebuilds it. Windows uses the FFmpeg libraries bundled with Liquidsoap.
The platform requirements above still apply to the complete installation.

### Initial configuration

Copy the templates only when the corresponding active files do not exist:

```bash
cp sc_serv.conf.example sc_serv.conf
cp autodj.config.json.example autodj.config.json
cp playlist.config.json.example playlist.config.json
```

Use `copy` instead of `cp` in Windows Command Prompt. Both Bash and PowerShell
accept the commands above.

1. Replace active placeholders in `sc_serv.conf`, including source and administrator passwords
2. Set the source host and matching password in `autodj.config.json`; `server.port` must equal DNAS `PortBase`
3. Match each enabled AutoDJ output's `streamId` to a configured DNAS stream
4. Add audio files to `playlists/universal/`
5. Validate the configuration and start both engines

```bash
npm run doctor
npm start
npm run autodj:start
```

ICY needs `PortBase + 1` as well as `PortBase`. Title publication requires
the matching `streamadminpassword_N` or global `adminpassword` in `sc_serv.conf`.

### System dependencies and external runtimes

The installer checks native libraries with `ldd` on Linux and FreeBSD, `otool`
on macOS, and the executable's PE imports on Windows. Linux SHOUTcast on FreeBSD
uses the Linux loader instead of native `ldd`. On macOS, `otool` requires Xcode
Command Line Tools. Damaged managed Windows packages can be reinstalled, then
must pass the same checks.

Suggested dependency commands use APT, DNF, pacman, FreeBSD `pkg`, Homebrew
or WinGet, where a package mapping is known. Run Homebrew without sudo.
Unknown libraries or incompatible library versions require a matching vendor
build; do not substitute DLLs or symlink incompatible library versions.

On FreeBSD x64, enable [Linuxulator](https://docs.freebsd.org/en/books/handbook/linuxemu/)
and install its Linux userland as root before installing the radio runtimes:

```sh
sysrc linux_enable="YES"
service linux start
pkg install linux_base-rl9
```

Then run `npm run install:freebsd` as the service account. The installer checks
kernel support, the Linux loader and userland execution before downloading or
compiling anything. SHOUTcast stays in `bin/shoutcast/freebsd-x64/`; its Linux
libraries are checked through the loader under `/compat/linux`, not native FreeBSD
`ldd`. Liquidsoap and FFmpeg remain native FreeBSD builds. No CPU emulation is
provided for FreeBSD ARM or 32-bit hosts. Externally supplied SHOUTcast binaries,
including older installations without a managed Linuxulator manifest, are preserved.

When no matching binary exists for the latest Liquidsoap release, the installer
uses [OPAM](https://www.liquidsoap.info/doc-2.4.5/install#install-using-opam)
to build it from official sources. Install OPAM 2.1 or newer, a C compiler, Bash,
make (`gmake` on FreeBSD), `pkg-config`, and development files for curl and libffi.
FFmpeg compilation also needs GnuPG, tar, xz, NASM on Intel CPUs, and development
files for LAME, OpenSSL and zlib.
`-dev` and `-devel` packages contain compilation headers for released libraries;
they are not nightly builds.

FFmpeg's own headers and libraries are installed locally. Ubuntu 22.04 can keep
its system FFmpeg 4.x: source-built Liquidsoap uses the compatible local FFmpeg
instead. Its launcher sets the required library paths, including when started by
a service manager. Official precompiled or externally supplied Liquidsoap binaries
still require the library versions they were built against.

To remove FFmpeg development packages installed by an earlier setup on Ubuntu,
first preview APT's removal plan:

```bash
sudo apt-get -s remove libavutil-dev libavformat-dev libavcodec-dev libavdevice-dev libavfilter-dev libswresample-dev libswscale-dev
```

If the plan does not remove anything else you need, repeat without `-s`.
Do not remove the curl, libffi, LAME, OpenSSL or zlib development packages needed
for future builds. No `autoremove` is needed. Runtime FFmpeg libraries and the
system `ffmpeg` package can remain installed.

Source builds run as the service account with a private OPAM root inside the
platform directory, for example `bin/liquidsoap/linux-x64/opam/`. The launcher
and manifest live in `bin/liquidsoap/linux-x64/runtime/`; macOS and FreeBSD use
their own platform directories. Official binary packages do not use OPAM.
The account's existing OPAM switches are untouched. Builds take time and need
extra disk space; a failed build leaves the previous runtime in place. Use a
project path without spaces or shell-special characters, and keep that absolute
path after building. Rebuild Liquidsoap if the repository moves. Do not run OPAM
as root or move its folders manually.

Older layouts are migrated during reinstall or a required source update, not
just because a newer layout exists. The old shared `bin/liquidsoap/opam/` is
removed only when it has no remaining switches or unrecognized files.
Successful source installations clean unused managed switches and build caches.
Older FFmpeg builds are kept until Liquidsoap uses the current build and no
uncertain switches or recovery directories remain. This preserves the libraries
needed by the previous Liquidsoap if an update fails. Unrecognized directories
and redirected paths are left alone; cleanup failures produce a warning.

For a POSIX shell:

```bash
export SC_SERV_BIN="/absolute/path/to/sc_serv"
npm run install
npm run doctor
```

Use `SC_SERV_BIN` for a manually installed DNAS binary, including one inside
`bin/`, to prevent the installer from replacing it. To supply Liquidsoap, set
`LIQUIDSOAP_BIN` and keep its runtime libraries and service environment available.
Installation checks it against the latest stable release; update an outdated
override or unset it to use the managed version.

## Operation

| Action | SHOUTcast | AutoDJ |
| --- | --- | --- |
| Start in background | `npm start` | `npm run autodj:start` |
| Stop | `npm run stop` | `npm run autodj:stop` |
| Restart | `npm run restart` | `npm run autodj:restart` |
| Status | `npm run status` (both engines) | `npm run autodj:status` |
| Follow logs | `npm run console` | `npm run autodj:console` |
| Clear active logs | `npm run logs:clear` | `npm run autodj:logs:clear` |

For Screen or a service manager, run each foreground command in its own session:

```bash
node server.js
node autodj.js
```

Do not use background start commands inside restart loops. Configure a service
manager for boot and crash recovery. On Unix-like hosts, quitting Screen or
closing the foreground terminal stops the managed engine; detaching leaves it
running. Shutdown allows up to 10 seconds before forced termination.

Console commands only follow logs. Ctrl+C closes the viewer, not the engine.
Restart prevalidates the executable and configuration before stopping the current
engine; AutoDJ also checks its generated Liquidsoap script. Prevalidation
failures leave the existing engine running.

Run `npm run help`, `npm run autodj:help` or
`npm run playlist -- --help` for command details. Use `--` to pass arguments
to an npm script, for example `npm run playlist -- --dry-run`. Platform-specific
`install:*`, `update:*`, `start:*` and `autodj:start:*` scripts select
`linux`, `windows`, `macos` or `freebsd`, for example `npm run start:windows`.
SHOUTcast also has `windows:x86` variants. The selection must match the host.

### Controller locks

Start, stop, restart and maintenance commands share `.run/control.lock` and wait
up to 30 seconds. Waiting messages show the operation and PID.
`.run/control-locks/` tracks pending startups and helps recover abandoned locks.
Use one local run directory for all commands controlling an instance.

The controller does not take a lock from a running process. It recovers an
abandoned lock only after the owner and pending startups have exited or finished.
Corrupt records, interrupted external installers and uncertain startups require
manual checks.

Before removing a reported lock or registration, stop restart loops and confirm
both engines and all controller operations are stopped. Never remove the
registration directory while commands are running.

## Configuration

Settings and defaults are documented in the root `.example` files. The SHOUTcast
template targets DNAS 2.6.1.777; check older builds against their shipped
documentation. AutoDJ and playlist configurations accept JSON comments and
trailing commas. Unknown keys and invalid values are rejected.

### Playlists and streams

`universal` is the default playlist. Add libraries in `playlist.config.json`
with unique IDs and `.lst` output files. Every enabled library must contain
supported audio files. `weight` sets its contribution per rotation round and
has no effect with one library. Set `enabled: false` to exclude a library.

Each enabled AutoDJ output needs a unique `id` and DNAS `streamId`. Its
`playlists` field selects IDs from `playlist.config.json`:

| Output selection | Tracks used |
| --- | --- |
| `["universal"]` | Default library only |
| `["universal", "pop"]` | Both named libraries |
| `[]` or omitted | All enabled libraries |

IDs are case-sensitive. Unknown, disabled and duplicate IDs are rejected for
enabled outputs; selection order defines rotation order. Different selections
have independent playback and metadata. Identical ordered selections share
decoding, but each stream has its own encoder and title recovery. Outputs share
the source host, password and station settings.

AutoDJ avoids consecutive tracks with the same filename, ignoring extension,
case and equivalent Unicode forms. A different name is a different track, even
if its audio is identical. Anti-repeat takes priority over weights; repetition
is allowed only when no differently named playable track is available in the
current playlist selection. Unplayable files are retried after a cooldown.

AutoDJ regenerates playlists before starting. After adding tracks to existing
libraries, run:

```bash
npm run playlist
```

The default reload interval is 300 seconds. Reloading preserves queued audio
and the last selected track name. Restart AutoDJ after changing output
selections or adding/disabling libraries. Crossfade, normalization, playback
mode and reload settings apply to every playback programme.

### Playlist schedules

Set `schedule` on a playlist in `playlist.config.json`. Scheduling requires
Liquidsoap `>=2.4.5` on all supported platforms. This example runs Monday to
Friday, 09:00–21:00:

```json
{
  "id": "weekday",
  "enabled": true,
  "directory": "playlists/weekday",
  "outputFile": "playlists/weekday.lst",
  "weight": 1,
  "schedule": [
    {
      "days": ["monday", "tuesday", "wednesday", "thursday", "friday"],
      "start": "09:00",
      "end": "21:00"
    }
  ]
}
```

Use lowercase day names from `monday` to `sunday`. Add entries to `schedule`
for different hours on other days. To run for whole days, omit both times:
`"schedule": [{ "days": ["saturday", "sunday"] }]`.

When using times, supply both `start` and `end` in `HH:MM` format. The start is
included and the end is excluded; `24:00` is allowed only as an end. An end
earlier than the start continues into the next day: Friday 22:00–02:00 ends on
Saturday. Times follow the server's local clock, including daylight-saving
changes; skipped hours are skipped and repeated hours follow the schedule again.

For consecutive playlists, use `start: "12:00", end: "13:00"` on one playlist
and `start: "13:00", end: "24:00"` on the other, both with `days: ["friday"]`.
At 13:00 AutoDJ finishes the current track before selecting from the second
playlist. Overlapping scheduled playlists share playback according to their
weights and anti-repeat rules; one does not override the other.

Scheduled playlists take priority during their active hours. Otherwise, or if
none has playable audio, AutoDJ uses playlists without `schedule` or with `[]`.
Keep a regular playlist such as `universal` for these gaps. If nothing is
available, AutoDJ outputs silence and retries. A playlist outside its scheduled
hours is never used as fallback.

Scheduled playback resolves tracks at each transition instead of prefetching.
Slow or unreadable files can delay the next track. With crossfade enabled, the
schedule is checked when the transition is prepared, before the audible end;
use `crossfadeSeconds: 0` to check at the end of the track. Playback without
schedules keeps its existing prefetch behavior.

The output's `playlists` selection must include the scheduled and regular
playlist IDs, or be empty to include all enabled playlists. Apply schedule
changes with `npm run autodj:restart`; `npm run playlist` only updates track lists.

### Audio and metadata

Default output is stereo MP3 at 320 kbps / 48 kHz. Higher-rate input is decoded
and resampled. MP3 output does not support 96/192 kHz; the AutoDJ template lists
valid bitrate/sample-rate combinations.

Valid Unicode tags are preserved. Titles use `Artist - Title` when both tags
exist, falling back to the filename without its extension when tags are missing.
AutoDJ publishes through ICY and the DNAS administration API. The supervisor
retains the current title and restores it after SHOUTcast reconnects.

The administration endpoint follows `destip` and `PortBase`. HTTP is permitted
only for loopback or local interface addresses. Set `RADIO_DNAS_URL` to an HTTPS
URL for remote administration and keep administrator credentials private.

`RADIO_METADATA_REPAIR=1` enables repair of recoverable mojibake from external
sources. It cannot restore characters already replaced with `�`; correct those
source tags instead.

## Logs

AutoDJ and SHOUTcast logging are independent.

| Log family | Settings | Default retention |
| --- | --- | --- |
| AutoDJ `autodj.log` | `logging` in `autodj.config.json` | Level 2; 10 MiB per file, 5 archives |
| SHOUTcast `sc_serv.stdout.log` and `sc_serv.error.log` | `SC_LOG_MAX_SIZE_MB`, `SC_LOG_MAX_FILES` | 10 MiB per file, 5 archives per family |
| Native DNAS and W3C logs | `sc_serv.conf` | Example: daily rotation, 5 archives |

Controller logs rotate at startup and at the size limit in foreground and
background mode. Archives use names such as `autodj_1.log`. Default retention
allows up to 60 MiB of newly written data per controller log family; existing
oversized archives remain until retention removes them.

Native DNAS rotation is time-based, not size-based. Monitor disk usage and keep
native log paths separate from controller capture files. Do not run two rotators
against the same file.

Clear-log commands require the relevant engine to be stopped. They irreversibly
empty active logs and retain archives. Retention deletes expired archives;
copy required logs before clearing or reducing limits. Log-write failures
stop the affected engine.

## Updates

Stop both engines with the existing controller before replacing code or binaries.
Disable supervisor restart loops during maintenance and back up active configs
and known-working runtimes.

### Controller code

FTP/archive installations can update from
[`evopixelro/radioserver`](https://github.com/evopixelro/radioserver), branch `main`:

```bash
npm run autodj:stop
npm run stop
npm run code:update
npm ci --ignore-scripts
npm run doctor
npm start
npm run autodj:start
```

No Git installation is required. The updater downloads one pinned commit,
checks each file against its Git blob hash and prints a summary of the changes.
File statuses are colored: `SKIP` gray, `ADDED`/`UPDATED` green,
`REMOVED`/`RESTORE` yellow and `LOCAL` red.

Managed files include `app/`, `tests/`, entrypoints, package metadata,
Git attributes/ignore rules and `.example` templates. `README.md` and `LICENSE`
are excluded, including from `--force` and `--rollback`. Active configs,
playlists, audio, binaries, logs, state and external start scripts are preserved.
Migrate template changes manually. Use Git's deployment workflow for Git checkouts.

The first update backs up and replaces differing managed code. Later updates
stop on local edits unless `--force` is supplied. Only previously managed files
can be removed when deleted upstream; untracked files are left alone.

```bash
npm run code:update -- --check
npm run code:update -- --force
npm run code:update -- --rollback
```

`--check` previews without writing and can run while streaming. `--rollback`
requires stopped engines and refuses to overwrite subsequent local edits.
Failed replacements trigger rollback. Interrupted updates block startup until
recovery; if the controller cannot run, restore the saved transaction and backup.

Backups and state live in `.run/code-update/`, independent of `RADIO_RUN_DIR`.
Keep the latest transaction and backup until deployment is validated.
Code updates do not install dependencies, update runtimes, execute downloaded
scripts or restart services. Hashes verify the download; review code changes
before deploying them.

### Runtime binaries

`npm run update` checks managed SHOUTcast, Liquidsoap and FFmpeg for updates:

```bash
npm run autodj:stop
npm run stop
npm run update
npm run doctor
npm start
npm run autodj:start
```

`install` and `update` use stable official releases, not rolling or prerelease
builds. A matching Liquidsoap binary is preferred; Unix hosts without one build
the same version through OPAM. Failed release lookups or missing prerequisites
stop the operation rather than selecting an older or mismatched package.

`install` reinstalls managed components, even at the same version. `update`
keeps working, current components and installs missing, changed or damaged ones.
FFmpeg and Liquidsoap updates refuse an automatic downgrade. When a local FFmpeg
build changes, source-built Liquidsoap is rebuilt against it. Configurations and
playlists are preserved. On Windows, FFmpeg is updated with the Liquidsoap bundle.

Liquidsoap assets are checked against published SHA-256 digests or recorded
checksums. SHOUTcast uses the official HTTPS distribution and a locally recorded
digest, not a separate vendor signature. Its `latest` package is downloaded for
comparison during update; an identical digest skips installation, and the download
is then cleaned up. Keep TLS verification enabled.

Successful installations remove recognized downloads, including older archives,
and their empty directories. Unrelated files are kept. Failed installations keep
their packages for troubleshooting. Liquidsoap's Debian package dependencies are
saved in its runtime manifest; older installations keep their active archive
until a reinstall records that information.

Packages are staged and validated where supported. Windows SHOUTcast uses the
vendor's interactive installer. The two engine updates are separate operations,
not one transaction. If Liquidsoap activation and restoration both fail, the
previous runtime is kept outside staging; the error reports its recovery path.

Explicit `SC_SERV_BIN`/`LIQUIDSOAP_BIN` overrides are never overwritten. Missing
overrides stop installation, and an outdated Liquidsoap override stops it with
an update message. Without an override, old system or user OPAM binaries are
left untouched while a current private runtime is installed in the project.

Debian/Ubuntu package-owned Liquidsoap can migrate to `bin/`; its OS libraries
remain external. After validating the local runtime, an old APT installation
can be removed with `sudo apt-get purge liquidsoap`. Review the proposed removals
and retain shared libraries used by the local binary.

## Deployment checks

Before putting a host into service:

- Run `npm run doctor` and resolve every failed check
- Verify audio, `/stats?sid=1`, `/currentsong?sid=1` and the listener application; repeat with each configured stream ID
- Restart SHOUTcast mid-track and confirm audio and the Unicode title recover
- Check rapid stop/start, supervisor shutdown, log retention and restart after reboot
- Restrict administration/source ports, protect credentials and use HTTPS for remote administration
- Run a sustained streaming test; monitor disk usage, process exits and stream availability

Doctor validates configuration, native dependencies and generated Liquidsoap
scripts without replacing active playlists or logs. Public routing, reverse
proxies, listener load and runtime compatibility need checks on the target host.

## Development and reference

```text
app/                          Controller modules
bin/                          Managed runtimes and download cache
playlists/universal/          Default audio library
tests/                        Unit and integration tests
autodj.config.json.example    AutoDJ settings
playlist.config.json.example  Playlist settings
sc_serv.conf.example          SHOUTcast settings
autodj.js                     AutoDJ entrypoint
server.js                     SHOUTcast entrypoint
```

State lives in `.run/`, logs in `logs/`, and DNAS access lists in `control/`
by default. Active configs, audio, binaries and generated files are excluded
from Git. No build step is required.

Run `npm test` for unit and integration tests. Platform tests cover detection,
command routing and installer decisions. Set `LIQUIDSOAP_TEST_BIN` to enable
native tests against local test servers (scheduled playback tests require
Liquidsoap >=2.4.5); `LIQUIDSOAP_TEST_RESOURCES` also tests
the relocated Linux standard library. Set `SHOUTCAST_TEST_BIN` to check DNAS
startup, restart and shutdown through the controller. With both executables set,
tests also check MP3 streaming and UTF-8 metadata on isolated local ports.
Tests without a required runtime are skipped. Test results do not replace
deployment checks.

GitHub Actions runs one job each for Ubuntu 22.04, Windows Server 2022, macOS 14,
FreeBSD 14.4 and Fedora 44. All jobs check the Liquidsoap/FFmpeg installer, run the
test suite and repeat the native playback tests. FreeBSD and Fedora run in virtual
machines. Ubuntu also checks that the system FFmpeg 4.x remains unchanged.

Real SHOUTcast installation and streaming tests run on Ubuntu and FreeBSD x64.
FreeBSD uses Linuxulator for DNAS, with native Liquidsoap and FFmpeg. The Windows,
macOS and Fedora jobs test the controller and Liquidsoap but do not run a real
DNAS stream. A passing macOS job does not imply native SHOUTcast support.

### Environment

| Variables | Purpose |
| --- | --- |
| `SC_SERV_BIN`, `LIQUIDSOAP_BIN` | External executable paths or commands |
| `SC_SERV_CONFIG` | DNAS configuration path |
| `RADIO_PLATFORM` | Host profile; automatic by default |
| `RADIO_RUN_DIR`, `RADIO_LOG_DIR` | State and log directories |
| `SC_SERV_ARGS_JSON` | Additional SHOUTcast arguments as a JSON string array |
| `SC_LOG_MAX_SIZE_MB`, `SC_LOG_MAX_FILES` | SHOUTcast capture limits: 1–1024 MiB, 1–100 archives |
| `AUTODJ_ROOT` | AutoDJ working directory |
| `RADIO_DNAS_URL`, `RADIO_DNAS_PORT`, `RADIO_ADMIN_PASSWORD` | Metadata administration endpoint and credentials |
| `RADIO_STREAM_ID` | Stream selection for optional metadata repair |
| `RADIO_METADATA_INTERVAL_MS`, `RADIO_METADATA_REPAIR` | Metadata check interval and encoding repair |

Relative config, state and log paths resolve from the repository root.
Use absolute playlist paths when changing `AUTODJ_ROOT`.

## License

The controller is licensed under [GPL-3.0-only](LICENSE). SHOUTcast, Liquidsoap
and their dependencies retain their own licenses. Vendor binaries are not
included in this repository.
