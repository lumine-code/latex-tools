const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

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

function fileSnapshot(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
      version: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(
        ":",
      ),
      changedAt: [stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs]
        .reduce((latest, time) => (time > latest ? time : latest))
        .toString(),
      writtenAt: stat.mtimeNs.toString(),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function readLog(logPath) {
  const before = fileSnapshot(logPath);
  if (!before) return null;
  let text;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  const after = fileSnapshot(logPath);
  if (!after || before.version !== after.version) return null;
  return { ...after, digest: createHash("sha256").update(text).digest("hex"), text };
}

function sourceFingerprint(filePath) {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function snapshotDiagnostics(filePath, inputPaths = [filePath]) {
  const log = readLog(filePath.replace(/\.tex$/, ".log"));
  return {
    log: log ? { version: log.version, digest: log.digest } : null,
    sourceFingerprint: sourceFingerprint(filePath),
    inputs: [...new Set([filePath, ...inputPaths])].map((inputPath) => ({
      path: inputPath,
      snapshot: fileSnapshot(inputPath),
    })),
  };
}

function currentLog(filePath, result) {
  // A launcher failure or termination cannot establish ownership of an old log.
  const before = result.plan?.diagnosticSnapshot;
  if (!before || result.error || result.signal || result.code == null) return null;
  const log = readLog(filePath.replace(/\.tex$/, ".log"));
  if (!log) return null;
  if (log.version !== before.log?.version || log.digest !== before.log?.digest) return log;
  // latexmk may succeed without rerunning TeX. Its existing log is usable only
  // while every source still predates it; ctime catches restored source mtimes.
  if (
    result.code === 0 &&
    before.inputs.every(({ path: inputPath, snapshot }) => {
      const current = fileSnapshot(inputPath);
      return (
        snapshot &&
        current?.version === snapshot.version &&
        BigInt(current.changedAt) <= BigInt(log.writtenAt)
      );
    })
  )
    return { ...log, reused: true };
  return null;
}

function diagnosticsFor(filePath, result) {
  const logPath = filePath.replace(/\.tex$/, ".log");
  const LogParser = require("./log-parser");
  const log = currentLog(filePath, result);
  let messages = log ? new LogParser().parse(log.text, filePath) : [];
  // An unchanged failure log cannot describe a successful no-op invocation.
  if (log?.reused && messages.some((message) => message.severity === "error")) messages = [];
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

module.exports = { commandFor, diagnosticsFor, snapshotDiagnostics, sourceFingerprint };
