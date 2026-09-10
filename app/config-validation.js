function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} setting: ${key}`);
  }
}

module.exports = { assertKnownKeys };
