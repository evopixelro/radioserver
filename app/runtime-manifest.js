const fs = require("node:fs");

function readRuntimeManifest(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw new Error(`Cannot read runtime manifest ${filePath}: ${error.message}`, { cause: error });
  }
}

module.exports = { readRuntimeManifest };
