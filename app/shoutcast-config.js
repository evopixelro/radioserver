const EXAMPLE_PLACEHOLDER_PATTERN = /CHANGE_ME|your_IP/i;

function parseShoutcastConfig(content) {
  const values = new Map();
  for (const originalLine of String(content).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    values.set(key, value);
  }
  return values;
}

function findActiveExamplePlaceholders(content) {
  return [...parseShoutcastConfig(content)]
    .filter(([, value]) => EXAMPLE_PLACEHOLDER_PATTERN.test(value))
    .map(([key]) => key);
}

function configurationIsReady(content) {
  return findActiveExamplePlaceholders(content).length === 0;
}

module.exports = {
  configurationIsReady,
  findActiveExamplePlaceholders,
  parseShoutcastConfig,
};
