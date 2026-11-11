// Document discovery, auxiliary cleanup and SyncTeX are LaTeX domain operations.
module.exports = ({ path, normalizePathForTex }) => {
  const allowsDiscovery = (filePath) =>
    typeof lumine === "undefined" ||
    !lumine.workspace?.getTextEditors ||
    require("./document-analysis").allowsAutomaticBuild(filePath);

  function hasRootDocumentMarkers(content) {
    return (
      /\\documentclass(?:\[[^\]]*\])?\s*\{/.test(content) || /\\begin\s*\{document\}/.test(content)
    );
  }

  function resolveTexReference(baseDir, reference) {
    const cleanReference = reference.trim().replace(/^["']|["']$/g, "");
    if (!cleanReference) {
      return null;
    }

    const resolvedPath = path.resolve(baseDir, cleanReference);
    return resolvedPath.endsWith(".tex") ? resolvedPath : `${resolvedPath}.tex`;
  }

  function collectTexReferences(content, candidateDir) {
    const references = [];
    const includePattern = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
    const importPattern = /\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]+)\}/g;
    let match;

    while ((match = includePattern.exec(content))) {
      const includedPath = resolveTexReference(candidateDir, match[1]);
      if (includedPath) {
        references.push(includedPath);
      }
    }

    while ((match = importPattern.exec(content))) {
      const importDir = path.resolve(candidateDir, match[1].trim());
      const includedPath = resolveTexReference(importDir, match[2]);
      if (includedPath) {
        references.push(includedPath);
      }
    }

    return references;
  }

  function texContentIncludesFile(content, candidateDir, sourcePath, visited = new Set()) {
    const fs = require("fs");
    const normalizedSource = normalizePathForTex(sourcePath);
    const references = collectTexReferences(content, candidateDir);

    for (const includedPath of references) {
      const normalizedIncludedPath = normalizePathForTex(includedPath);
      if (normalizedIncludedPath === normalizedSource) {
        return true;
      }

      if (
        visited.has(normalizedIncludedPath) ||
        !allowsDiscovery(includedPath) ||
        !fs.existsSync(includedPath)
      ) {
        continue;
      }

      visited.add(normalizedIncludedPath);
      let includedContent;
      try {
        includedContent = fs.readFileSync(includedPath, "utf8");
      } catch {
        continue;
      }

      if (
        texContentIncludesFile(includedContent, path.dirname(includedPath), sourcePath, visited)
      ) {
        return true;
      }
    }

    return false;
  }

  function flsContentIncludesFile(content, flsDir, sourcePath) {
    const normalizedSource = normalizePathForTex(sourcePath);
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const match = line.match(/^INPUT\s+(.+)$/);
      if (!match) {
        continue;
      }

      const inputPath = match[1].trim();
      const resolvedInputPath = path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(flsDir, inputPath);
      if (normalizePathForTex(resolvedInputPath) === normalizedSource) {
        return true;
      }
    }

    return false;
  }

  return {
    cleanFile(filePath) {
      const cleanPatterns = lumine.config.get("latex-tools.cleanExtensions") || [];
      if (cleanPatterns.length === 0) {
        lumine.notifications.addWarning("No auxiliary file extensions configured", {
          detail: "Please configure auxiliary file extensions in latex-tools settings.",
          dismissable: true,
        });
        return;
      }
      let deletedFiles, failedFiles;
      try {
        ({ deletedFiles, failedFiles } = require("./auxiliary-files").cleanAuxiliaries(
          filePath,
          cleanPatterns,
        ));
      } catch (error) {
        lumine.notifications.addError("Failed to read directory", {
          detail: error.message,
          dismissable: true,
        });
        return;
      }

      // Show results
      if (deletedFiles.length > 0) {
        lumine.notifications.addSuccess(`Cleaned ${deletedFiles.length} auxiliary file(s)`, {
          detail: deletedFiles.join("\n"),
          dismissable: true,
        });
      } else {
        lumine.notifications.addInfo("No auxiliary files found to clean");
      }

      if (failedFiles.length > 0) {
        lumine.notifications.addWarning(`Failed to delete ${failedFiles.length} file(s)`, {
          detail: failedFiles.join("\n"),
          dismissable: true,
        });
      }

      // Clear linter messages
      this.cleanLinter();
    },

    getWatchPaths(filePath) {
      const fs = require("node:fs");
      const paths = new Set([filePath]);
      const pending = [filePath];
      // The recorder does not exist before the first compilation. Discover
      // explicit inputs too, so enabling observation on a chapter works then.
      while (pending.length) {
        const source = pending.pop();
        if (!allowsDiscovery(source) || !fs.existsSync(source)) continue;
        for (const reference of collectTexReferences(
          fs.readFileSync(source, "utf8"),
          path.dirname(source),
        )) {
          if (paths.has(reference)) continue;
          paths.add(reference);
          pending.push(reference);
        }
      }
      const recorder = filePath.replace(/\.tex$/, ".fls");
      if (fs.existsSync(recorder)) {
        const projectPath = lumine.project.relativizePath(filePath)[0] || path.dirname(filePath);
        const outputPath = normalizePathForTex(filePath.replace(/\.tex$/, ".pdf"));
        for (const line of fs.readFileSync(recorder, "utf8").split(/\r?\n/)) {
          const match = /^INPUT\s+(.+)$/.exec(line);
          if (!match) continue;
          const input = path.resolve(path.dirname(filePath), match[1].trim());
          const relative = path.relative(projectPath, input);
          // Auxiliary files are compiler outputs even when TeX reads them in
          // a later pass. Watching them would trigger an endless rebuild loop.
          if (
            !relative.startsWith("..") &&
            !path.isAbsolute(relative) &&
            normalizePathForTex(input) !== outputPath &&
            /\.(?:tex|bib|sty|cls|bst|def|cfg|clo|png|jpe?g|pdf|eps|svg)$/i.test(input)
          )
            paths.add(input);
        }
      }
      return [...paths];
    },

    resolveTexRoot(filePath) {
      if (!filePath || !filePath.endsWith(".tex")) {
        return null;
      }

      const fs = require("fs");

      const { detectRootFromMagicComment } = require("./utils");
      const explicitRoot = detectRootFromMagicComment(filePath);
      if (explicitRoot && fs.existsSync(explicitRoot)) {
        return explicitRoot;
      }

      const ownSyncPath = filePath.replace(/\.tex$/, ".synctex.gz");
      if (fs.existsSync(ownSyncPath)) {
        return filePath;
      }

      const candidates = this.findRootCandidatesForFile(filePath);
      return candidates.length > 0 ? candidates[0] : filePath;
    },

    findRootCandidatesForFile(filePath) {
      const fs = require("fs");
      const sourcePath = path.resolve(filePath);
      const sourceDir = path.dirname(sourcePath);
      const projectPaths =
        typeof lumine !== "undefined" && lumine.project && lumine.project.getPaths
          ? lumine.project.getPaths().map((projectPath) => path.resolve(projectPath))
          : [];
      const candidateDirs = [];

      let currentDir = sourceDir;
      while (currentDir && !candidateDirs.includes(currentDir)) {
        candidateDirs.push(currentDir);

        const reachedProjectRoot = projectPaths.some(
          (projectPath) => normalizePathForTex(projectPath) === normalizePathForTex(currentDir),
        );
        if (reachedProjectRoot) {
          break;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
          break;
        }
        currentDir = parentDir;
      }

      const candidates = [];
      for (const candidateDir of candidateDirs) {
        let entries;
        try {
          entries = fs.readdirSync(candidateDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".fls")) {
            const flsPath = path.join(candidateDir, entry.name);
            const candidatePath = flsPath.replace(/\.fls$/, ".tex");
            if (
              normalizePathForTex(candidatePath) === normalizePathForTex(sourcePath) ||
              !allowsDiscovery(candidatePath) ||
              !allowsDiscovery(flsPath)
            ) {
              continue;
            }

            let content;
            try {
              content = fs.readFileSync(flsPath, "utf8");
            } catch {
              continue;
            }

            if (
              fs.existsSync(candidatePath) &&
              flsContentIncludesFile(content, candidateDir, sourcePath)
            ) {
              candidates.push({
                filePath: candidatePath,
                hasOutput: true,
                hasSync: fs.existsSync(candidatePath.replace(/\.tex$/, ".synctex.gz")),
              });
            }
            continue;
          }

          const candidatePath = path.join(candidateDir, entry.name);
          if (
            !entry.isFile() ||
            !entry.name.endsWith(".tex") ||
            normalizePathForTex(candidatePath) === normalizePathForTex(sourcePath) ||
            !allowsDiscovery(candidatePath)
          ) {
            continue;
          }

          let content;
          try {
            content = fs.readFileSync(candidatePath, "utf8");
          } catch {
            continue;
          }

          const candidateHasSync = fs.existsSync(candidatePath.replace(/\.tex$/, ".synctex.gz"));
          const candidateHasOutput =
            candidateHasSync || fs.existsSync(candidatePath.replace(/\.tex$/, ".pdf"));

          if (
            texContentIncludesFile(content, candidateDir, sourcePath) &&
            (candidateHasOutput || hasRootDocumentMarkers(content))
          ) {
            candidates.push({
              filePath: candidatePath,
              hasOutput: candidateHasOutput,
              hasSync: candidateHasSync,
            });
          }
        }
      }

      const uniqueCandidates = [];
      const seenCandidates = new Set();
      for (const candidate of candidates) {
        const normalizedCandidate = normalizePathForTex(candidate.filePath);
        if (seenCandidates.has(normalizedCandidate)) {
          continue;
        }

        seenCandidates.add(normalizedCandidate);
        uniqueCandidates.push(candidate);
      }

      return uniqueCandidates
        .sort(
          (a, b) =>
            Number(b.hasSync) - Number(a.hasSync) || Number(b.hasOutput) - Number(a.hasOutput),
        )
        .map((candidate) => candidate.filePath);
    },

    async syncToPdf(texPath, line, column = 0) {
      if (!texPath || !texPath.endsWith(".tex")) {
        return null;
      }

      const rootPath = this.resolveTexRoot(texPath);
      if (!rootPath) {
        return null;
      }

      const pdfPath = rootPath.replace(/\.tex$/, ".pdf");
      const syncPath = rootPath.replace(/\.tex$/, ".synctex.gz");
      const fs = require("fs");

      if (!fs.existsSync(syncPath)) {
        if (lumine.config.get("latex-tools.debug")) {
          console.log("[LaTeX Tools] SyncTeX file not found:", syncPath);
        }
        return null;
      }

      try {
        const { execFileSync } = require("child_process");
        const synctexPath = lumine.config.get("latex-tools.synctexPath") || "synctex";
        const result = execFileSync(
          synctexPath,
          ["view", "-i", `${line}:${column}:${texPath}`, "-o", pdfPath],
          {
            encoding: "utf8",
            timeout: 5000,
          },
        );

        // Parse synctex output
        const pageMatch = result.match(/Page:(\d+)/);
        const xMatch = result.match(/x:([\d.]+)/);
        const yMatch = result.match(/y:([\d.]+)/);
        const widthMatch = result.match(/W:([\d.]+)/);
        const heightMatch = result.match(/H:([\d.]+)/);

        if (pageMatch) {
          return {
            page: parseInt(pageMatch[1], 10),
            x: xMatch ? parseFloat(xMatch[1]) : 0,
            y: yMatch ? parseFloat(yMatch[1]) : 0,
            width: widthMatch ? parseFloat(widthMatch[1]) : 0,
            height: heightMatch ? parseFloat(heightMatch[1]) : 0,
            pdfPath,
            rootPath,
          };
        }

        return null;
      } catch (error) {
        if (lumine.config.get("latex-tools.debug")) {
          console.error("[LaTeX Tools] SyncTeX forward sync failed:", error);
        }
        return null;
      }
    },

    async syncToSource(pdfPath, page, x, y) {
      if (!pdfPath || !pdfPath.endsWith(".pdf")) {
        return null;
      }

      const syncPath = pdfPath.replace(/\.pdf$/, ".synctex.gz");
      const fs = require("fs");

      if (!fs.existsSync(syncPath)) {
        if (lumine.config.get("latex-tools.debug")) {
          console.log("[LaTeX Tools] SyncTeX file not found:", syncPath);
        }
        return null;
      }

      try {
        const { execFileSync } = require("child_process");
        const synctexPath = lumine.config.get("latex-tools.synctexPath") || "synctex";
        const result = execFileSync(synctexPath, ["edit", "-o", `${page}:${x}:${y}:${pdfPath}`], {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });

        // Parse synctex output
        const inputMatch = result.match(/Input:(.+)/);
        const lineMatch = result.match(/Line:(\d+)/);
        const columnMatch = result.match(/Column:(\d+)/);

        if (inputMatch && lineMatch) {
          return {
            file: inputMatch[1].trim(),
            line: parseInt(lineMatch[1], 10),
            column: columnMatch ? parseInt(columnMatch[1], 10) : 0,
          };
        }

        return null;
      } catch (error) {
        if (lumine.config.get("latex-tools.debug")) {
          console.error("[LaTeX Tools] SyncTeX backward sync failed:", error);
        }
        return null;
      }
    },
  };
};
