#!/usr/bin/env bash
set -euo pipefail

destination="${1:?Pass the FFmpeg fixture directory}"
mkdir -p "$destination"

curl_args=(
    -4 --fail --location --silent --show-error
    --retry 5 --retry-all-errors --retry-delay 3 --retry-max-time 240
    --connect-timeout 15 --max-time 300
)

fetch()
{
    curl "${curl_args[@]}" --output "$2" "$1"
}

fetch "https://ffmpeg.org/releases/" "$destination/releases.html"

version="$(
    RADIOSERVER_CI_CATALOG="$destination/releases.html" node <<'NODE'
const fs = require("node:fs");
const ffmpeg = require("./app/ffmpeg-runtime");

ffmpeg.latestVersion(async () => ({
    ok: true,
    status: 200,
    text: async () => fs.readFileSync(process.env.RADIOSERVER_CI_CATALOG, "utf8"),
})).then((version) => process.stdout.write(version)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
NODE
)"

fetch "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" "$destination/ffmpeg-$version.tar.xz"
fetch "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz.asc" "$destination/ffmpeg-$version.tar.xz.asc"
fetch "https://ffmpeg.org/ffmpeg-devel.asc" "$destination/ffmpeg-devel.asc"

printf '%s\n' "$version" > "$destination/version"
printf 'Prepared FFmpeg %s CI fixtures in %s\n' "$version" "$destination"
