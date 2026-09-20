#!/usr/bin/env bash
set -euo pipefail

# A private, signed upstream build provides current development libraries on Jammy.
# This is a CI fixture, not part of the RadioServer runtime installer.
version=7.1.5
prefix="$RUNNER_TEMP/ffmpeg-$version"
source_root=$(mktemp -d "$RUNNER_TEMP/ffmpeg-source.XXXXXX")
keyring="$source_root/gnupg"
mkdir -m 700 "$keyring"
curl --fail --location --retry 3 https://ffmpeg.org/ffmpeg-devel.asc -o "$source_root/release-key.asc"
fingerprint=$(gpg --homedir "$keyring" --show-keys --with-colons "$source_root/release-key.asc" | awk -F: '$1 == "fpr" {print $10; exit}')
test "$fingerprint" = FCF986EA15E6E293A5644F10B4322F04D67658D8
gpg --homedir "$keyring" --batch --import "$source_root/release-key.asc"
for suffix in tar.xz tar.xz.asc; do
    curl --fail --location --retry 3 "https://ffmpeg.org/releases/ffmpeg-$version.$suffix" -o "$source_root/ffmpeg.$suffix"
done
gpg --homedir "$keyring" --batch --verify "$source_root/ffmpeg.tar.xz.asc" "$source_root/ffmpeg.tar.xz"
tar -xf "$source_root/ffmpeg.tar.xz" -C "$source_root"
cd "$source_root/ffmpeg-$version"
./configure --prefix="$prefix" --disable-doc --disable-debug --disable-programs \
    --enable-shared --disable-static --disable-x86asm --enable-libmp3lame
make -j2
make install
echo "PKG_CONFIG_PATH=$prefix/lib/pkgconfig:${PKG_CONFIG_PATH:-}" >> "$GITHUB_ENV"
echo "LD_LIBRARY_PATH=$prefix/lib:${LD_LIBRARY_PATH:-}" >> "$GITHUB_ENV"
