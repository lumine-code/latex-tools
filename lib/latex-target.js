const fs = require("node:fs");
const path = require("node:path");

const EXIT_CODES = {
  10: "Bad command line arguments",
  11: "File not found",
  12: "Failure in making files",
  13: "Error in initialization file",
  20: "Probable bug in latexmk",
};

function commandFor(filePath) {
  const args = ["-bibtex", "-interaction=nonstopmode", "-file-line-error"];
  const engine =
    require("./utils").detectEngineFromMagicComment(filePath) ||
    lumine.config.get("latex-tools.latexEngine") ||
    "pdflatex";
  args.push(engine === "xelatex" ? "-xelatex" : engine === "lualatex" ? "-lualatex" : "-pdf");
  const verbosity = lumine.config.get("latex-tools.outputVerbosity") || "default";
  if (verbosity === "silent") args.push("-silent");
  if (verbosity === "quiet") args.push("-quiet");
  if (lumine.config.get("latex-tools.enableSynctex")) args.push("-synctex=1");
  if (lumine.config.get("latex-tools.shellEscape")) args.push("-shell-escape");
  args.push(path.basename(filePath));
  return {
    name: `LaTeX: ${path.basename(filePath)}`,
    cmd: lumine.config.get("latex-tools.latexmkPath") || "latexmk",
    args,
    cwd: path.dirname(filePath),
    shell: false,
  };
}

function diagnosticsFor(filePath, result) {
  const logPath = filePath.replace(/\.tex$/, ".log");
  const LogParser = require("./log-parser");
  const messages = fs.existsSync(logPath)
    ? new LogParser().parse(fs.readFileSync(logPath, "utf8"), filePath)
    : [];
  const failed = Boolean(result.error) || (result.code != null && result.code !== 0);
  const verbosity = lumine.config.get("latex-tools.outputVerbosity") || "default";
  const filtered = messages.filter((message) => {
    if (failed) return message.severity === "error";
    return verbosity === "extended" || !["info", "hint"].includes(message.severity);
  });
  if (failed && filtered.length === 0) {
    filtered.push({
      severity: "error",
      excerpt: result.error?.message || EXIT_CODES[result.code] || "LaTeX compiler error",
      location: {
        fullPath: filePath,
        position: { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } },
      },
    });
  }
  const seen = new Set();
  return filtered.flatMap((message) => {
    const { start, end } = message.location.position;
    const key = `${message.severity}|${message.location.fullPath}|${start.row}:${start.column}|${message.excerpt}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        severity: message.severity,
        excerpt: message.excerpt,
        description: message.description || undefined,
        location: {
          file: message.location.fullPath,
          position: [
            [start.row, start.column],
            [end.row, end.column],
          ],
        },
        ...(message.logRange
          ? { reference: { file: logPath, position: message.logRange[0] } }
          : {}),
      },
    ];
  });
}

module.exports = { commandFor, diagnosticsFor };
