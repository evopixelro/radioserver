# RadioServer

Node.js controller for SHOUTcast DNAS and Liquidsoap AutoDJ. Handles runtime
installation, playlists, process supervision, UTF-8 metadata and log retention.

## Requirements

- Node.js `>=22.0.0`; use a maintained LTS release with current security patches
- SHOUTcast DNAS built for the host OS and architecture
- Liquidsoap >=2.2.5 (>=2.4.5 for playlist schedules) with FFmpeg support and the configured audio codecs
- FFmpeg on Linux, macOS and FreeBSD; included in the managed Windows Liquidsoap package
- A dedicated service account with write access to the repository and its data directories

Run commands from the repository root as the service account. Only system
dependency installation may require elevated privileges. Startup and maintenance
commands enforce the Node.js minimum; help, diagnostics, status, console and
stop commands remain available for recovery on older versions.

### Platforms

| Platform | Runtime installation |
| --- | --- |
| Linux | SHOUTcast x64/x86 downloads; latest official Liquidsoap package or a private OPAM source build |
| Windows | SHOUTcast x64/x86 vendor installer; Liquidsoap x64 portable package |
| macOS / FreeBSD | Externally supplied compatible SHOUTcast; latest Liquidsoap built from official sources with OPAM |

Debian/Ubuntu packages are selected for the exact distribution release and
architecture, not reused across unrelated systems. Missing packages use the
source-build path on Unix. Native 32-bit Windows requires a separately supplied
compatible Liquidsoap build; the installer does not substitute an older release.

Both engines must work on the target host. macOS, Apple Silicon and FreeBSD
require native validation of supplied binaries. The controller does not install
emulation or download older Mac/BSD DNAS builds.

[Current SHOUTcast server downloads](https://shoutcast.com/pricing/basic) target
Linux and Windows. For a complete current stack on a Mac or FreeBSD host without
a compatible native DNAS binary, run RadioServer and both engines together in a
Linux virtual machine. A Linux executable cannot be used as a native Mac/BSD
replacement through `SC_SERV_BIN`.

## Installation

Read the [SHOUTcast DNAS license](https://www.shoutcast.com/legal/agreements/dnas)
before installing. The npm `install` and `update` scripts include
`--accept-license`; acceptance is saved in `bin/shoutcast/license.json`.

```bash
npm install
npm run install
```

`npm install` runs the Node.js lifecycle script without installing radio runtimes.
`npm run install` installs or reinstalls managed runtimes into `bin/`, including
Liquidsoap's standard library and local FFmpeg, or validates externally supplied
runtimes. Active configurations stay in the repository root.

The installer marks available requirements in green, missing requirements in
red and system installation commands in yellow. Run any suggested commands
separately, then repeat `npm run install` as the service account. The controller
never installs OS packages itself. Colors are disabled for redirected output
and `NO_COLOR`.

On Linux, Windows, macOS and FreeBSD, a system dependency section appears above
the runtime list during install and update. SHOUTcast and Liquidsoap have separate
native library lists, showing both available and missing libraries. If an executable
is not available yet, its native library check is marked `NOT CHECKED` until the
executable is downloaded or supplied. Archive tools are listed separately from
runtime libraries. Source builds list each build tool and development library
separately, including the detected version and the FFmpeg minimum version check.
Missing libraries include package installation commands where a mapping is known,
shown in yellow below the system dependency list. Libraries installed outside
the system paths must be visible to `pkg-config`. Official binary installations
do not require the source-build tools; the Windows package also includes FFmpeg.
The checks do not install system packages.
For a first installation, native libraries are checked again after extraction,
before activating the new executable.
After a successful installation or update, each managed runtime removes its
recognized downloaded packages, including older archives. Empty download directories
are removed too; unrelated files are kept. A failed installation keeps its package
for troubleshooting. Liquidsoap's Debian package dependencies are recorded in the
runtime manifest so diagnostics do not need the downloaded archive.
Older binary installations retain their active Debian archive until a reinstall
records this metadata; obsolete packages are still removed.

On Linux, macOS and FreeBSD, install and update build the newest stable FFmpeg
release supported by Liquidsoap in `bin/ffmpeg/<os>-<arch>/`. Sources come from
ffmpeg.org and must pass signature verification against the upstream release key.
The system FFmpeg is left unchanged. `update` reuses a validated local build when
its version is current; `install` rebuilds it. Windows uses the FFmpeg libraries already
included in the local official Liquidsoap package; no separate Unix build is needed.

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

Native dependency inspection is required. Linux and FreeBSD use `ldd`; macOS
uses `otool` from Xcode Command Line Tools. Windows dependencies are read from
the executable's PE imports. Managed Windows packages can be repaired by
reinstalling; replacement binaries must pass validation.

Suggested dependency commands use APT, DNF, pacman, FreeBSD `pkg`, Homebrew
or WinGet, where a package mapping is known. Run Homebrew without sudo.
Unknown libraries or incompatible library versions require a matching vendor
build; do not substitute DLLs or symlink incompatible library versions.

On macOS and FreeBSD, supply a compatible licensed SHOUTcast executable.
When no matching binary exists for the latest Liquidsoap release, the installer
uses [OPAM](https://www.liquidsoap.info/doc-2.4.5/install#install-using-opam)
to compile that exact version from the official release sources. Install OPAM 2.1 or newer,
a C compiler, Bash, make (`gmake` on FreeBSD), `pkg-config`, and development files for
curl and libffi first. Local FFmpeg compilation also needs GnuPG, tar, xz, NASM on
Intel CPUs, and development files for LAME, OpenSSL and zlib. The installer lists
missing requirements and the appropriate OS package commands before building.
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
The account's existing OPAM switches are untouched. Builds require additional time and disk
space. Checksums remain enabled; system packages are never installed by the
controller. A failed build leaves the previous active runtime in place.
Keep the repository at the same absolute path after a source build; rebuild
Liquidsoap if it is moved. Do not run OPAM as root.
Older layouts remain readable, so an up-to-date `update` does not trigger a
rebuild just to rearrange folders. `install`, or a necessary source update,
builds in the platform-specific location before removing the previous switch.
The old shared `bin/liquidsoap/opam/` is removed only after no switches remain
and it contains only recognized OPAM metadata; other platforms and unknown files
are preserved. Do not move existing OPAM folders manually.
After successful source installation or validation, unused managed OPAM switches
and build/download caches are cleaned. FFmpeg builds keep their fixed paths while
in use; registered older builds are removed only after the active Liquidsoap uses
the current build and no uncertain switches or recovery directories remain.
Failed updates retain the libraries needed by the previous Liquidsoap. Unrecognized
older directories and redirected paths are not deleted automatically; cleanup
failures report a warning without invalidating the installed runtime.
Unix source builds require a project path without spaces or shell-special characters.

For a POSIX shell:

```bash
export SC_SERV_BIN="/absolute/path/to/sc_serv"
npm run install
npm run doctor
```

To supply your own Liquidsoap instead, set `LIQUIDSOAP_BIN` explicitly and keep
its full runtime and service environment. Installation verifies it against the
latest stable release; an outdated override must be updated or unset.
A manual DNAS binary can also reside at `bin/shoutcast/<os>-<arch>/sc_serv`.
Supplied SHOUTcast binaries remain externally managed, even inside `bin/`.

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

Lifecycle and runtime changes share `.run/control.lock` and wait up to 30 seconds.
Waiting messages identify the operation and PID. Registrations in
`.run/control-locks/` coordinate startup and abandoned-lock recovery.
Use one local run directory for all commands controlling an instance.

A live owner is never evicted. Abandoned locks are recovered only after the
owner and registered startup supervisors have exited or finished. Corrupt
records, interrupted external installers and uncertain engine startup require
manual verification.

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
valid bitrate/sample-rate combinations. Loudness normalization changes audio
levels, not text encoding.

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

No Git installation is required. Downloads are pinned to one commit and checked
against Git blob hashes. Each file's status and a final count are printed.
Only status words are colored: `SKIP` gray, `ADDED`/`UPDATED` green,
`REMOVED`/`RESTORE` yellow and `LOCAL` red. Brackets and filenames are uncolored.

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
scripts or restart services. Hash verification checks integrity, not whether
a commit is suitable for deployment.

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

Both `install` and `update` check the latest stable official Liquidsoap and
compatible FFmpeg releases before changing runtimes. Rolling and prerelease builds are excluded.
A matching official binary is preferred; Unix hosts without one build the same
version through OPAM. There is no fallback to an older release or a package
for another distribution. Lookup or prerequisite failures stop the operation.
`install` installs missing components and reinstalls managed components already
present, even at the same version. `update` keeps validated current components
and only installs missing, changed or damaged ones. FFmpeg and Liquidsoap updates
refuse an automatic downgrade if the release catalogue is older than the installed
version. A new local FFmpeg build also requires rebuilding a managed source-based
Liquidsoap to link it to the new libraries. Configs and playlists are preserved.
Windows updates FFmpeg through its Liquidsoap bundle.

Liquidsoap assets are checked against published SHA-256 digests or recorded
checksums. SHOUTcast uses the official HTTPS distribution and a locally recorded
digest, not a separate vendor signature. Its `latest` package is downloaded for
comparison during update; an identical digest skips installation, and the download
is then cleaned up. Keep TLS verification enabled.

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
the relocated Linux standard library. Tests without a required native runtime
are skipped. Test results do not replace deployment checks.

GitHub Actions runs one job per test system: Ubuntu 22.04, Windows Server 2022,
macOS 14, FreeBSD 14.4 and Fedora 44. Each job checks the managed runtime installer,
the full test suite and repeated native playback regressions. FreeBSD and Fedora
run in separate virtual machines. Ubuntu also checks that installing local FFmpeg
leaves the distribution's FFmpeg 4.x unchanged.

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
