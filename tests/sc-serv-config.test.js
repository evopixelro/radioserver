const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  configurationIsReady,
  findActiveExamplePlaceholders,
} = require("../app/shoutcast-config");

const REQUIRED_DIRECTIVES = `
adaptivebuffersize admetricsdebug admincssfile adminpassword agentfile
allowpublicrelay allowrelay alternateports artworkfile autodumptime autodumpusers
backupfile backuploop backuptitle banfile blockemptyuseragent bufferhardlimit
buffertype cdn cdnmaster cdnslave configrewrite cpucount destip faviconfile
faviconmimetype fixedbuffersize flashpolicyfile flashpolicyserverdebug
flashpolicyserverport hidestats httpstyledebug include introfile licenceid
listenertime log logarchive logclients logfile logrotates maxbitrate
maxheaderlinecount maxheaderlinesize maxhttpredirects maxspecialfilesize maxuser
metainterval microserverdebug minbitrate namelookups password pidfile portbase
portlegacy publicip publicport publicserver redirecturl relayconnectretries
relaydebug relayport relayreconnecttime relayserver relayshoutcastdebug
relayuvoxdebug requirestreamconfigs ripfile riponly robotstxtfile rotateinterval
saveagentlistonexit savebanlistonexit saveriplistonexit screenlog
shoutcast1clientdebug shoutcast2clientdebug shoutcastsourcedebug songhistory srcip
sslcertificatefile sslcertificatekeyfile statsdebug streamadminpassword
streamagentfile streamallowpublicrelay streamallowrelay streamartworkfile
streamauthhash streamautodumptime streamautodumpusers streambackupfile
streambackuploop streambackuptitle streambackupurl streambanfile streamdatadebug
streamhidestats streamid streamintrofile streamlistenertime streammaxbitrate
streammaxuser streamminbitrate streammovedurl streampassword streampath
streamportlegacy streampublicserver streamredirecturl streamrelayurl
streamripfile streamriponly streamsonghistory streamw3clog threadrunnerdebug
titleformat unique urlformat userid uvox2sourcedebug uvoxcipherkey w3cenable
w3clog webclientdebug yp2debug ypaddr ypmaxretries ypminreportinterval yppath
ypport ypreportinterval yptimeout
`.trim().split(/\s+/);

function normalizeDirective(value) {
  return value.toLowerCase().replace(/_\d+$/, "");
}

test("ignores example placeholders in comments", () => {
  const content = `
; Replace CHANGE_ME values in active settings
;adminpassword=CHANGE_ME_ADMIN_PASSWORD
adminpassword=secret
# destip=your_IP
destip=127.0.0.1
`;
  assert.equal(configurationIsReady(content), true);
  assert.deepEqual(findActiveExamplePlaceholders(content), []);
});

test("reports only active example placeholders", () => {
  const content = `
;password=CHANGE_ME_COMMENTED_PASSWORD
password=CHANGE_ME_STREAM_PASSWORD
destip=your_IP
`;
  assert.deepEqual(findActiveExamplePlaceholders(content), ["password", "destip"]);
  assert.equal(configurationIsReady(content), false);
});

test("documents the complete DNAS 2.6.1.777 configuration surface", () => {
  const configPath = path.join(__dirname, "..", "sc_serv.conf.example");
  const content = fs.readFileSync(configPath, "utf8");
  const documented = new Set();
  const enabled = [];

  for (const originalLine of content.split(/\r?\n/)) {
    const line = originalLine.trim();
    const match = line.match(/^;?([A-Za-z][A-Za-z0-9_]*)(?:_\d+)?=/);
    if (!match) continue;
    documented.add(normalizeDirective(match[1]));
    if (!line.startsWith(";")) enabled.push(normalizeDirective(match[1]));
  }

  for (const directive of REQUIRED_DIRECTIVES) {
    assert.ok(documented.has(directive), `Missing documented directive: ${directive}`);
  }
  assert.deepEqual(enabled.sort(), [
    "logrotates",
    "rotateinterval",
    "portbase",
    "destip",
    "adminpassword",
    "password",
    "requirestreamconfigs",
    "streamadminpassword",
    "streamid",
    "streampassword",
    "streampath",
    "logfile",
    "w3clog",
    "banfile",
    "ripfile",
    "streamauthhash",
  ].sort());
});
