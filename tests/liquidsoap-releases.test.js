const assert = require("node:assert/strict");
const test = require("node:test");
const { selectRelease, latestPackage } = require("../app/liquidsoap-releases");

function release(version, codename = "noble", options = {}) {
  const name = `liquidsoap_${version}-ubuntu-${codename}-ocaml4.14.2-2_amd64.deb`;
  return {
    tag_name: `v${version}`, prerelease: false, draft: false,
    assets: [{ name, browser_download_url: `https://github.com/savonet/liquidsoap-release-assets/releases/download/v${version}/${name}`, digest: `sha256:${"a".repeat(64)}` }],
    ...options,
  };
}
const target = { family: "linux", distribution: "ubuntu", codename: "noble", architecture: "x64" };

test("selects the newest stable matching OS package and excludes rolling builds", () => {
  const result = selectRelease([
    release("2.4.5"), release("2.4.10"), release("3.0.0", "noble", { prerelease: true }),
    release("4.0.0", "noble", { draft: true }), release("2.5.0", "jammy"),
    release("2.5.0", "noble", { tag_name: "rolling-release-v2.5.x" }),
  ], target);
  assert.equal(result.version, "2.4.10");
});

test("an older OS gets its newest compatible release, never another distribution's package", () => {
  const result = selectRelease([release("2.4.5"), release("2.2.5", "jammy")], { ...target, codename: "jammy" });
  assert.equal(result.version, "2.2.5");
  assert.equal(selectRelease([release("2.4.5")], { ...target, codename: "jammy" }), null);
});

test("unpublished checksums require an exact previously verified asset URL", () => {
  const item = release("2.2.5");
  delete item.assets[0].digest;
  assert.throws(() => selectRelease([item], target), /no published SHA-256/);
  const known = [{ url: item.assets[0].browser_download_url, sha256: "b".repeat(64) }];
  assert.equal(selectRelease([item], target, known).sha256, "b".repeat(64));
});

test("release lookup reports network failure instead of claiming an old version is latest", async () => {
  await assert.rejects(latestPackage(target, process.cwd(), [], async () => ({ ok: false, status: 403 })), /HTTP 403/);
});

test("latest release selection compares all pages instead of trusting publication order", async () => {
  let page = 0;
  const result = await latestPackage(target, process.cwd(), [], async () => ({
    ok: true,
    json: async () => ++page === 1 ? Array.from({ length: 100 }, () => release("2.4.5")) : [release("2.4.10")],
  }));
  assert.equal(result.version, "2.4.10");
  assert.equal(page, 2);
});
