const path = require("node:path");

const RELEASES_API = "https://api.github.com/repos/savonet/liquidsoap-release-assets/releases";
const ASSET_PREFIX = "https://github.com/savonet/liquidsoap-release-assets/releases/download/";

function versionParts(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag || "");
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function selectRelease(releases, target, knownPackages = []) {
  const stable = releases.filter((release) =>
    !release.draft && !release.prerelease && versionParts(release.tag_name) &&
    compareVersions(release.tag_name, "2.2.5") >= 0,
  ).sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  for (const release of stable) {
    const version = versionParts(release.tag_name).join(".");
    const architecture = { x64: "amd64", arm64: "arm64", x86: "i386" }[target.architecture];
    const assets = (release.assets || []).filter((asset) => {
      if (target.family === "windows") return asset.name === `liquidsoap-${version}-win64.zip`;
      const prefix = `liquidsoap_${version}-${target.distribution}-${target.codename}-`;
      return architecture && asset.name.startsWith(prefix) &&
        asset.name.endsWith(`_${architecture}.deb`) &&
        /^[a-zA-Z0-9_.-]+$/.test(asset.name);
    }).sort((a, b) => {
      const preferred = Number(b.name.includes("ocaml4.")) - Number(a.name.includes("ocaml4."));
      return preferred || b.name.localeCompare(a.name, "en", { numeric: true });
    });
    if (!assets.length) continue;
    const asset = assets[0];
    if (!asset.browser_download_url.startsWith(ASSET_PREFIX)) {
      throw new Error("Liquidsoap release asset does not use the official distribution URL.");
    }
    const known = knownPackages.find((item) => item.url === asset.browser_download_url);
    const sha256 = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || "")?.[1].toLowerCase() || known?.sha256;
    if (!sha256) {
      throw new Error(`Official Liquidsoap ${version} asset has no published SHA-256: ${asset.name}.`);
    }
    return {
      version, fileName: asset.name, url: asset.browser_download_url, sha256,
      directoryName: target.family === "windows" ? `liquidsoap-${version}-win64` : undefined,
    };
  }
  return null;
}

async function latestPackage(target, serverRoot, knownPackages, fetchImplementation = globalThis.fetch) {
  const catalogue = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImplementation(`${RELEASES_API}?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "RadioServer runtime installer" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Could not check official Liquidsoap releases: HTTP ${response.status}. Try again later.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("Invalid Liquidsoap release response.");
    catalogue.push(...releases);
    if (releases.length < 100) {
      const selected = selectRelease(catalogue, target, knownPackages);
      if (selected) return {
        ...selected,
        filePath: path.join(serverRoot, "bin", "downloads", "liquidsoap", selected.fileName),
      };
      break;
    }
    if (page === 10) throw new Error("Official Liquidsoap release catalogue exceeds the pagination limit; refusing to claim a partially checked version is latest.");
  }
  throw new Error(`No stable official Liquidsoap package matches ${target.family}/${target.distribution || ""}/${target.codename || ""}/${target.architecture}.`);
}

module.exports = { compareVersions, latestPackage, selectRelease };
