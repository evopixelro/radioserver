const fs = require("node:fs");

function cleanupRuntimeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch (error) {
    console.warn(`Runtime cleanup warning: could not fully remove ${directory} (${error.code || error.message}). Close processes using that directory before removing the remaining files.`);
    return false;
  }
}

module.exports = { cleanupRuntimeDirectory };
