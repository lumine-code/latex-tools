const fs = require("node:fs");
const path = require("node:path");
const { matchesPattern } = require("./utils");

function cleanAuxiliaries(filePath, patterns) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath, ".tex");
  const files = fs.readdirSync(directory);
  const attempted = new Set();
  const deletedFiles = [];
  const failedFiles = [];
  for (const pattern of patterns) {
    const wildcard = pattern.includes("*") || pattern.includes("?");
    const candidates = wildcard
      ? files.filter((file) => matchesPattern(file, pattern, basename))
      : [`${basename}.${pattern}`];
    for (const file of candidates) {
      const fullPath = path.join(directory, file);
      // Source, document output and the map used by PDF navigation survive
      // even an explicitly configured broad wildcard.
      if (
        [".tex", ".pdf"].includes(path.extname(file).toLowerCase()) ||
        /\.synctex(?:\.gz)?$/i.test(file) ||
        attempted.has(fullPath) ||
        !fs.existsSync(fullPath)
      )
        continue;
      attempted.add(fullPath);
      try {
        fs.unlinkSync(fullPath);
        deletedFiles.push(file);
      } catch {
        failedFiles.push(file);
      }
    }
  }
  return { deletedFiles, failedFiles };
}

module.exports = { cleanAuxiliaries };
