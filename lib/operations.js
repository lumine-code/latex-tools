// Compilation, filesystem discovery and SyncTeX are used by explicit TeX operations.
module.exports = ({ path, normalizePathForTex }) => {
  const allowsDiscovery = (filePath) =>
    typeof lumine === "undefined" ||
    !lumine.workspace?.getTextEditors ||
    require("./document-analysis").allowsAutomaticBuild(filePath);

  /**
   * Latexmk exit codes with descriptions
   * @see https://github.com/debian-tex/latexmk/blob/main/latexmk.pl
   */
  const LATEXMK_EXIT_CODES = {
    10: "Bad command line arguments",
    11: "File not found",
    12: "Failure in making files",
    13: "Error in initialization file",
    20: "Probable bug in latexmk",
  };

  function getExitCodeDescription(code) {
    if (LATEXMK_EXIT_CODES[code]) {
      return LATEXMK_EXIT_CODES[code];
    }
    if (code > 0) {
      return "LaTeX compiler error";
    }
    return "Unknown error";
  }

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
      const fs = require("fs");
      const { matchesPattern } = require("./utils");
      const fileDir = path.dirname(filePath);
      const baseName = path.basename(filePath, ".tex");

      // Get auxiliary file extensions/patterns from config
      const cleanPatterns = lumine.config.get("latex-tools.cleanExtensions") || [];

      if (cleanPatterns.length === 0) {
        lumine.notifications.addWarning("No auxiliary file extensions configured", {
          detail: "Please configure auxiliary file extensions in latex-tools settings.",
          dismissable: true,
        });
        return;
      }

      let deletedFiles = [];
      let failedFiles = [];
      // Overlapping patterns must not retry files from the directory snapshot.
      const attemptedPaths = new Set();

      // Read all files in the directory
      let allFiles;
      try {
        allFiles = fs.readdirSync(fileDir);
      } catch (error) {
        lumine.notifications.addError("Failed to read directory", {
          detail: error.message,
          dismissable: true,
        });
        return;
      }

      // Process each pattern
      for (const pattern of cleanPatterns) {
        // Check if pattern contains wildcards
        const hasWildcard = pattern.includes("*") || pattern.includes("?");

        if (hasWildcard) {
          // Pattern matching with wildcards
          for (const file of allFiles) {
            if (matchesPattern(file, pattern, baseName)) {
              const fullPath = path.join(fileDir, file);
              try {
                // Don't delete the .tex or .pdf files
                if (
                  ![".tex", ".pdf"].includes(path.extname(file).toLowerCase()) &&
                  !attemptedPaths.has(fullPath)
                ) {
                  attemptedPaths.add(fullPath);
                  fs.unlinkSync(fullPath);
                  deletedFiles.push(file);
                  if (lumine.config.get("latex-tools.debug")) {
                    console.log(`[LaTeX Tools] Deleted: ${fullPath}`);
                  }
                }
              } catch (error) {
                failedFiles.push(file);
                if (lumine.config.get("latex-tools.debug")) {
                  console.error(`[LaTeX Tools] Failed to delete ${fullPath}:`, error);
                }
              }
            }
          }
        } else {
          // Simple extension matching (legacy behavior)
          const auxFile = path.join(fileDir, `${baseName}.${pattern}`);
          if ([".tex", ".pdf"].includes(path.extname(auxFile).toLowerCase())) continue;
          if (!attemptedPaths.has(auxFile) && fs.existsSync(auxFile)) {
            attemptedPaths.add(auxFile);
            try {
              fs.unlinkSync(auxFile);
              deletedFiles.push(`${baseName}.${pattern}`);
              if (lumine.config.get("latex-tools.debug")) {
                console.log(`[LaTeX Tools] Deleted: ${auxFile}`);
              }
            } catch (error) {
              failedFiles.push(`${baseName}.${pattern}`);
              if (lumine.config.get("latex-tools.debug")) {
                console.error(`[LaTeX Tools] Failed to delete ${auxFile}:`, error);
              }
            }
          }
        }
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

      // Reset build state and status bar to idle
      this.setBuildState(filePath, "idle");
      if (this.statusBarView) {
        this.statusBarView.setStatus("idle");
      }
    },

    runCompilation(filePath) {
      const generation = this.activationGeneration;
      const processes = this.buildProcesses;
      const ownsActivation = () =>
        this.activationGeneration === generation &&
        this.buildProcesses === processes &&
        this.subscriptions &&
        !this.subscriptions.disposed;
      if (!ownsActivation()) return;
      filePath = this.getRootFilePath(filePath) || filePath;
      if (!ownsActivation()) return;
      const fileName = path.basename(filePath);
      const fileDir = path.dirname(filePath);

      // Build latexmk arguments based on config
      const args = [
        "-bibtex", // Run bibtex when needed
        "-interaction=nonstopmode", // Don't stop on errors
        "-file-line-error", // Better error messages
      ];

      // Select LaTeX engine (magic comment overrides config)
      const { detectEngineFromMagicComment } = require("./utils");
      const magicEngine = detectEngineFromMagicComment(filePath);
      const engine = magicEngine || lumine.config.get("latex-tools.latexEngine") || "pdflatex";
      if (engine === "xelatex") {
        args.push("-xelatex");
      } else if (engine === "lualatex") {
        args.push("-lualatex");
      } else {
        args.push("-pdf"); // pdflatex (default)
      }

      // Set output verbosity
      const verbosity = lumine.config.get("latex-tools.outputVerbosity") || "default";
      if (verbosity === "silent") {
        args.push("-silent");
      } else if (verbosity === "quiet") {
        args.push("-quiet");
      }

      // Add SyncTeX if enabled
      if (lumine.config.get("latex-tools.enableSynctex")) {
        args.push("-synctex=1");
      }

      // Add shell escape if enabled
      if (lumine.config.get("latex-tools.shellEscape")) {
        args.push("-shell-escape");
      }

      // Add clean option if enabled
      if (lumine.config.get("latex-tools.cleanAuxFiles")) {
        args.push("-c");
      }

      // Add the file name as the last argument
      args.push(fileName);

      // Track build start time
      const startTime = Date.now();
      // Publish ownership before callbacks can interrupt, replace or retire a
      // build. A cancelled start must never acquire a compiler afterwards.
      const processInfo = { process: null, startTime, completed: false };
      processes.set(filePath, processInfo);
      const current = () =>
        ownsActivation() && processes.get(filePath) === processInfo && !processInfo.completed;

      // Update status bar and store build state
      this.setBuildState(filePath, "building", `Compiling ${fileName}`, {
        startTime,
      });
      if (!current()) return;

      if (this.isStatusBarActiveFor(filePath)) {
        if (!current()) return;
        this.statusBarView.setStatus("building", `Compiling ${fileName}`);
      }
      if (!current()) return;

      lumine.notifications.addInfo(`Compiling ${fileName}…`);
      if (!current()) return;

      // Clear linter messages at start of compilation
      this.linterProvider.clearMessages();
      if (!current()) return;

      // Update panel to show building state
      if (this.latexPanel) {
        this.latexPanel.setBuilding(filePath);
      }
      if (!current()) return;

      // Notify build service
      const buildService = this.buildService;
      const buildRecord = buildService?.startBuild(filePath);
      if (!current()) return;

      const failed = (error) => {
        if (!current()) return;
        const elapsedTime = Date.now() - startTime;
        processInfo.completed = true;
        processes.delete(filePath);
        lumine.commands.invalidateAvailability();
        this.setBuildState(filePath, "error", "latexmk not found", {
          startTime,
          elapsedTime,
        });
        if (this.isStatusBarActiveFor(filePath)) {
          this.statusBarView.setStatus("error", "latexmk not found");
          this.statusBarView.showElapsedTime(elapsedTime);
        }
        lumine.notifications.addError("Failed to run latexmk", {
          detail: `Make sure latexmk is installed and in your PATH.\n\nError: ${error.message}`,
          dismissable: true,
        });
        buildService?.failBuild(filePath, "latexmk not found", error.message, buildRecord);
      };

      let stdout = "";
      let stderr = "";

      // Use child_process.spawn for better process control
      const latexmkPath = lumine.config.get("latex-tools.latexmkPath") || "latexmk";
      const { spawn } = require("child_process");
      let childProcess;
      try {
        childProcess = spawn(latexmkPath, args, {
          cwd: fileDir,
          shell: false,
          // On Unix-like systems, create a new process group for easier termination
          detached: process.platform !== "win32",
        });
      } catch (error) {
        failed(error);
        return;
      }

      // Store the process reference for interruption
      processInfo.process = childProcess;
      if (!current()) {
        // A copied spawn hook may retire this start before it returns a child.
        // That child is still ours to reap, including a later spawn error.
        childProcess.on("error", () => {});
        this.killProcess(childProcess);
        return;
      }
      lumine.commands.invalidateAvailability();

      // Capture stdout
      childProcess.stdout.on("data", (data) => {
        if (current()) stdout += data.toString();
      });

      // Capture stderr
      childProcess.stderr.on("data", (data) => {
        if (current()) stderr += data.toString();
      });

      // Handle process exit
      childProcess.on("exit", (code, signal) => {
        if (!current()) return;
        // Calculate elapsed time
        const elapsedTime = Date.now() - startTime;

        // Remove from tracking
        processInfo.completed = true;
        processes.delete(filePath);
        lumine.commands.invalidateAvailability();

        // Check if process was killed by signal (interrupted)
        if (signal) {
          if (lumine.config.get("latex-tools.debug")) {
            console.log(`[LaTeX Tools] Process terminated by signal: ${signal}`);
          }
          this.setBuildState(filePath, "idle", "Build interrupted");
          if (this.isStatusBarActiveFor(filePath))
            this.statusBarView.setStatus("idle", "Build interrupted");
          buildService?.failBuild(
            filePath,
            `Build interrupted by signal ${signal}`,
            stderr || stdout,
            buildRecord,
          );
          return; // Don't show success/error notifications for interrupted builds
        }

        if (code === 0) {
          this.setBuildState(filePath, "success", `${fileName} compiled successfully`, {
            startTime,
            elapsedTime,
          });
          // Update status bar if this file is still active (editor or PDF view)
          if (this.isStatusBarActiveFor(filePath)) {
            this.statusBarView.setStatus("success", `${fileName} compiled successfully`);
            this.statusBarView.showElapsedTime(elapsedTime);
          }

          // Notify user
          lumine.notifications.addSuccess(`${fileName} compiled successfully`, {
            detail: `Completed in ${Math.floor(elapsedTime / 1000)}s`,
          });

          if (lumine.config.get("latex-tools.debug")) {
            console.log(`LaTeX compilation completed in ${elapsedTime}ms`);
          }

          // Parse log file and update panel
          this.parseLogFile(filePath);

          // Notify build service of success
          buildService?.finishBuild(filePath, stdout, elapsedTime, buildRecord);
        } else {
          const exitCodeDesc = getExitCodeDescription(code);
          this.setBuildState(
            filePath,
            "error",
            `Compilation failed: ${exitCodeDesc} (exit code ${code})`,
            { startTime, elapsedTime },
          );
          // Update status bar if this file is still active (editor or PDF view)
          if (this.isStatusBarActiveFor(filePath)) {
            this.statusBarView.setStatus("error", `Compilation failed: ${exitCodeDesc} (${code})`);
            this.statusBarView.showElapsedTime(elapsedTime);
          }

          // Notify user
          lumine.notifications.addError(`${fileName} compilation failed`, {
            detail: `Exit code ${code}: ${exitCodeDesc}\nCompleted in ${Math.floor(elapsedTime / 1000)}s`,
            dismissable: true,
          });

          if (lumine.config.get("latex-tools.debug")) {
            console.error(`LaTeX compilation failed after ${elapsedTime}ms:`, stderr || stdout);
          }

          // Try to parse log file for error messages
          const fs = require("fs");
          const logPath = filePath.replace(/\.tex$/, ".log");
          let messages = [];
          let hasErrors = false;

          if (fs.existsSync(logPath)) {
            try {
              const logContent = fs.readFileSync(logPath, "utf8");
              const parsedMessages = this.logParser.parse(logContent, filePath);
              // Check if there are any error-severity messages
              hasErrors = parsedMessages.some((msg) => msg.severity === "error");
              if (hasErrors) {
                // Only show errors, none of the lower severities
                messages = parsedMessages.filter((msg) => msg.severity === "error");
              }
            } catch (error) {
              if (lumine.config.get("latex-tools.debug")) {
                console.error("[LaTeX Tools] Failed to parse log file on error:", error);
              }
            }
          }

          // If no errors found in log, use fallback critical message
          if (!hasErrors) {
            messages = [
              {
                severity: "error",
                location: {
                  fullPath: filePath,
                  position: {
                    start: { row: 0, column: 0 },
                    end: { row: 0, column: 0 },
                  },
                },
                excerpt: `Critical error: ${exitCodeDesc} (exit code ${code})`,
                description:
                  "The LaTeX compiler encountered a critical error or was interrupted. Check the console output for details.",
              },
            ];
          }

          if (this.linterProvider) {
            this.linterProvider.setMessages(messages);
          }

          // Emit messages update event
          if (buildService) {
            buildService.updateMessages(filePath, messages);
            buildService.failBuild(
              filePath,
              `${exitCodeDesc} (exit code ${code})`,
              stderr || stdout,
              buildRecord,
            );
          }
        }
      });

      // Handle process errors (e.g., command not found)
      childProcess.on("error", failed);
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
