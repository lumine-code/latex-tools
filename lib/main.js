const { CompositeDisposable, Disposable, watchFile } = require("atom");
const { spawn } = require("child_process");
const path = require("path");
const StatusBarView = require("./status-bar-view");
const BuildService = require("./build-service");
const LogParser = require("./log-parser");
const LinterProvider = require("./linter-provider");
const ObservedFilesList = require("./observed-list");
const ObservedFilesStatusView = require("./observed-status");
const {
  detectEngineFromMagicComment,
  detectRootFromMagicComment,
  matchesPattern,
  getLatexmkrcPath,
  createLatexmkrc,
} = require("./utils");

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

/**
 * Get a description for a latexmk exit code
 * @param {number} code - The exit code
 * @returns {string} Description of the exit code
 */
function isPending(item) {
  if (item.isPending != null) {
    return item.isPending();
  }
  const pane = atom.workspace.getActivePane();
  return pane ? pane.getPendingItem() === item : false;
}

function getExitCodeDescription(code) {
  if (LATEXMK_EXIT_CODES[code]) {
    return LATEXMK_EXIT_CODES[code];
  }
  if (code > 0) {
    return "LaTeX compiler error";
  }
  return "Unknown error";
}

function normalizePathForTex(filePath) {
  const normalizedPath = path.normalize(filePath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
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

    if (visited.has(normalizedIncludedPath) || !fs.existsSync(includedPath)) {
      continue;
    }

    visited.add(normalizedIncludedPath);
    let includedContent;
    try {
      includedContent = fs.readFileSync(includedPath, "utf8");
    } catch {
      continue;
    }

    if (texContentIncludesFile(includedContent, path.dirname(includedPath), sourcePath, visited)) {
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

/**
 * LaTeX Tools Package
 * Provides LaTeX compilation, PDF viewing, and error parsing.
 * Supports latexmk compilation, SyncTeX synchronization, compile-on-save,
 * and integration with linter and open-external packages.
 */
module.exports = {
  subscriptions: null,
  statusBarView: null,
  statusBarTile: null,
  observedFilesStatusView: null,
  observedFilesStatusTile: null,
  openExternalService: null,
  buildService: null,
  logParser: null,
  linterProvider: null, // Linter provider for displaying issues
  observedFilesList: null,
  buildStates: null, // Track build state per file
  buildProcesses: null, // Track build processes per file for interruption
  compileOnSaveFiles: null, // Track file paths with compile-on-save enabled
  currentTexFile: null, // Current tex file shown in status bar (for PDF viewer support)

  /**
   * Activates the package and registers LaTeX commands.
   * @param {Object} state - Serialized state from previous session
   */
  activate() {
    this.subscriptions = new CompositeDisposable();
    this.buildService = new BuildService();
    this.buildService.setMainModule(this); // Set reference for API delegation
    this.logParser = new LogParser();
    this.linterProvider = new LinterProvider();
    this.observedFilesList = new ObservedFilesList(this);
    this.observedFilesStatusView = new ObservedFilesStatusView({
      onOpenObservedFiles: () => this.showObservedFiles(),
      onClearObservedFiles: () => this.clearCompileOnSaveFiles(),
    });
    this.statusBarView = new StatusBarView({
      onCompile: () => this.compileFromStatusBar(),
      onOpenPdf: () => this.openPdfFromStatusBar(),
      onKillAndClean: () => this.killAndCleanFromStatusBar(),
      onToggleCompileOnSave: () => this.toggleCompileOnSave(),
    });
    this.buildStates = new Map(); // Initialize build states tracking
    this.buildProcesses = new Map(); // Initialize build processes tracking
    this.compileOnSaveFiles = new Map(); // Initialize compile-on-save tracking

    // Register commands
    this.subscriptions.add(
      // One registration, on the workspace. Packages > LaTeX Tools is always
      // visible and the application menu dispatches at whatever holds focus, so
      // a grammar scope here meant every item did nothing unless a .tex editor
      // had focus. The keymap still carries that scope, and every handler
      // already refuses with a notification outside a saved LaTeX file.
      atom.commands.add("atom-workspace", {
        "latex-tools:compile": () => this.compile(),
        "latex-tools:open-pdf": () => this.openPdf(),
        "latex-tools:open-pdf-external": () => this.openPdfExternal(),
        "latex-tools:clean": () => this.clean(),
        "latex-tools:clean-linter": () => this.cleanLinter(),
        "latex-tools:interrupt": () => this.interrupt(),
        "latex-tools:interrupt-all": () => this.interruptAll(),
        "latex-tools:kill-and-clean": () => this.killAndClean(),
        "latex-tools:toggle-compile-on-save": () => this.toggleCompileOnSave(),
        "latex-tools:synctex": () => this.synctex(),
        "latex-tools:global-rc": () => this.openLatexmkrc(),
        "latex-tools:observed-files": () => this.showObservedFiles(),
        "latex-tools:clear-all-observed-files": () => this.clearCompileOnSaveFiles(),
      }),
      // Track active pane item changes (text editors and PDF viewers)
      atom.workspace.getCenter().observeActivePaneItem((item) => {
        if (!item) {
          this.statusBarView.hide();
        } else if (item.filePath && item.filePath.endsWith(".pdf")) {
          // PDF viewer - show status bar if adjacent .tex exists
          this.updateStatusBarVisibility(item, "pdf");
        } else if (atom.workspace.isTextEditor(item)) {
          // Text editor - show status bar if .tex file
          this.updateStatusBarVisibility(item, "editor");
        } else {
          this.statusBarView.hide();
        }
      }),
    );
  },

  /**
   * Deactivates the package and cleans up resources.
   */
  deactivate() {
    // Kill all running build processes
    if (this.buildProcesses) {
      for (const processInfo of this.buildProcesses.values()) {
        this.killProcess(processInfo.process);
      }
      this.buildProcesses.clear();
    }

    // Clean up compile-on-save observers
    if (this.compileOnSaveFiles) {
      for (const info of this.compileOnSaveFiles.values()) {
        if (info.disposable) {
          info.disposable.dispose();
        }
        if (info.timeout) {
          clearTimeout(info.timeout);
        }
      }
      this.compileOnSaveFiles.clear();
    }

    this.subscriptions.dispose();
    if (this.statusBarTile) {
      this.statusBarTile.destroy();
    }
    if (this.observedFilesStatusTile) {
      this.observedFilesStatusTile.destroy();
      this.observedFilesStatusTile = null;
    }
    if (this.statusBarView) {
      this.statusBarView.destroy();
    }
    if (this.observedFilesStatusView) {
      this.observedFilesStatusView.destroy();
      this.observedFilesStatusView = null;
    }
    if (this.buildService) {
      this.buildService.destroy();
    }
    if (this.observedFilesList) {
      this.observedFilesList.destroy();
      this.observedFilesList = null;
    }
  },

  serialize() {
    return {};
  },

  consumeStatusBar(statusBar) {
    // Language-tooling band on the left, observer band on the right. See the
    // priority convention in the status-bar package README.
    this.statusBarTile = statusBar.addLeftTile({
      item: this.statusBarView.getElement(),
      priority: 420,
    });
    this.observedFilesStatusTile = statusBar.addRightTile({
      item: this.observedFilesStatusView.getElement(),
      priority: 510,
    });
    this.updateObservedFilesStatus();

    // Update visibility based on current active item
    const activeEditor = atom.workspace.getActiveTextEditor();
    if (activeEditor) {
      this.updateStatusBarVisibility(activeEditor, "editor");
    }
  },

  consumeOpenExternal(service) {
    this.openExternalService = service;
    return new Disposable(() => {
      this.openExternalService = null;
    });
  },

  provideLatexTools() {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Providing latex-tools service");
    }
    return this.buildService;
  },

  consumeLinterRegistry(registerIndie) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Consuming linter.registry service");
    }
    const linter = registerIndie({
      name: "LaTeX",
    });
    this.subscriptions.add(linter);
    this.linterProvider.register(linter);
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Linter indie instance registered");
    }
  },

  updateStatusBarVisibility(item, type) {
    // Show status bar for .tex files or adjacent PDF viewers
    if (!this.statusBarView) {
      return;
    }

    const fs = require("fs");
    let filePath = null;

    if (type === "editor") {
      filePath = item.getPath();
      if (!filePath || !filePath.endsWith(".tex")) {
        this.statusBarView.hide();
        return;
      }
    } else if (type === "pdf") {
      const texFilePath = item.filePath.replace(/\.pdf$/, ".tex");
      if (!fs.existsSync(texFilePath)) {
        this.statusBarView.hide();
        return;
      }
      filePath = texFilePath;
    }

    if (!filePath) {
      this.currentTexFile = null;
      this.statusBarView.hide();
      return;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;

    // Track current root tex file for status bar actions
    this.currentTexFile = rootPath;

    // Get the build state for this file and update status bar
    const buildState = this.getBuildState(rootPath);
    if (atom.config.get("latex-tools.debug")) {
      console.log(
        "[LaTeX Tools] Restoring build state:",
        buildState.status,
        "for",
        path.basename(rootPath),
      );
    }

    // Check if this file is currently building (has active process)
    const processInfo = this.buildProcesses.get(rootPath);
    if (processInfo) {
      // File is actively building - restore with running timer
      this.statusBarView.setStatus(buildState.status, buildState.message, { skipTimer: true });
      this.statusBarView.restoreTimer(processInfo.startTime);
    } else if (buildState.elapsedTime) {
      // File has completed build - show elapsed time
      this.statusBarView.setStatus(buildState.status, buildState.message);
      this.statusBarView.showElapsedTime(buildState.elapsedTime);
    } else {
      // Normal status update
      this.statusBarView.setStatus(buildState.status, buildState.message);
    }

    // Update compile-on-save indicator for the displayed source file.
    this.statusBarView.setCompileOnSave(this.isCompileOnSaveEnabledForFile(filePath));

    this.statusBarView.show();
  },

  setBuildState(filePath, status, message = "", timerInfo = {}) {
    // Store build state for a specific file
    const existingState = this.buildStates.get(filePath) || {};
    this.buildStates.set(filePath, {
      status: status,
      message: message,
      timestamp: Date.now(),
      startTime: timerInfo.startTime || existingState.startTime || null,
      elapsedTime: timerInfo.elapsedTime || null,
    });
    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] Build state for ${path.basename(filePath)}: ${status}`);
    }
  },

  getBuildState(filePath) {
    // Get build state for a specific file, default to idle
    if (this.buildStates.has(filePath)) {
      return this.buildStates.get(filePath);
    }
    return {
      status: "idle",
      message: "LaTeX",
      timestamp: null,
      startTime: null,
      elapsedTime: null,
    };
  },

  // Check if the status bar should be updated for the given file
  // Returns true if the file is either the active editor or shown via PDF viewer
  isStatusBarActiveFor(filePath) {
    const rootPath = this.getRootFilePath(filePath) || filePath;
    const activeEditor = atom.workspace.getActiveTextEditor();
    const activePath = activeEditor?.getPath();
    if (activePath && activePath.endsWith(".tex")) {
      const activeRootPath = this.getRootFilePath(activePath) || activePath;
      if (activeRootPath === rootPath) {
        return true;
      }
    } else if (activePath === rootPath) {
      return true;
    }
    // Also check if the current tex file matches (PDF viewer case)
    return this.currentTexFile === rootPath;
  },

  parseLogFile(filePath) {
    const fs = require("fs");
    const logPath = filePath.replace(/\.tex$/, ".log");

    if (!fs.existsSync(logPath)) {
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] Log file not found:", logPath);
      }
      // Clear linter messages if no log file
      if (this.linterProvider) {
        this.linterProvider.clearMessages();
      }
      // Emit empty messages update
      if (this.buildService) {
        this.buildService.updateMessages(filePath, []);
      }
      return;
    }

    try {
      const logContent = fs.readFileSync(logPath, "utf8");
      const messages = this.logParser.parse(logContent, filePath);

      // Send messages to linter
      if (this.linterProvider) {
        this.linterProvider.setMessages(messages);
      }

      // Emit messages update event
      if (this.buildService) {
        this.buildService.updateMessages(filePath, messages);
      }

      // Get statistics
      const stats = this.logParser.getStatistics();
      if (atom.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Parsed log file:`, stats);
      }
    } catch (error) {
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] Failed to parse log file:", error);
      }
    }
  },

  checkBuildStatus(filePath) {
    // Check if a build is currently in progress for this file
    const rootPath = this.getRootFilePath(filePath) || filePath;
    return this.buildProcesses.has(rootPath);
  },

  waitForBuildAndOpen(filePath, pdfPath, openExternal = false) {
    // Subscribe to build finish/fail events
    const disposable = new CompositeDisposable();

    const openPdfAfterBuild = () => {
      disposable.dispose();
      // Delay slightly to ensure file is fully written
      setTimeout(() => {
        if (openExternal) {
          this._openPdfExternalDirect(pdfPath);
        } else {
          this._openPdfDirect(pdfPath);
        }
      }, 100);
    };

    disposable.add(
      this.buildService.onDidFinishBuild((data) => {
        if (data.file === filePath) {
          openPdfAfterBuild();
        }
      }),
      this.buildService.onDidFailBuild((data) => {
        if (data.file === filePath) {
          disposable.dispose();
          atom.notifications.addWarning("Build failed", {
            detail: "PDF may be incomplete or outdated.",
            dismissable: true,
          });
        }
      }),
    );

    atom.notifications.addInfo("Waiting for compilation to finish...", {
      description: "The PDF will open automatically when the build completes.",
      dismissable: true,
    });
  },

  _openPdfDirect(pdfPath, options = {}) {
    atom.workspace
      .open(pdfPath, { searchAllPanes: true, ...options })
      .then(() => {
        atom.notifications.addInfo(`Opened ${path.basename(pdfPath)}`);
      })
      .catch((error) => {
        atom.notifications.addError("Failed to open PDF", {
          detail: error.message,
          dismissable: true,
        });
      });
  },

  _openPdfExternalDirect(pdfPath) {
    if (!this.openExternalService) {
      atom.notifications.addWarning("open-external service not available", {
        detail: "Please install the open-external package",
        dismissable: true,
      });
      return;
    }

    this.openExternalService
      .openExternal(pdfPath)
      .then(() => {
        atom.notifications.addInfo(`Opened ${path.basename(pdfPath)} externally`);
      })
      .catch((error) => {
        atom.notifications.addError("Failed to open PDF externally", {
          detail: error ? error.message || error : "Unknown error",
          dismissable: true,
        });
      });
  },

  openPdf() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      atom.notifications.addWarning("Not a LaTeX file");
      return;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;
    const pdfPath = this.getPdfPathForFile(filePath);

    // Check if build is in progress
    if (this.checkBuildStatus(rootPath)) {
      this.waitForBuildAndOpen(rootPath, pdfPath, false);
      return;
    }

    // Check if PDF exists
    const fs = require("fs");
    if (!fs.existsSync(pdfPath)) {
      atom.notifications.addWarning("PDF file not found", {
        detail: `Expected file: ${pdfPath}\n\nPlease compile the LaTeX file first.`,
        dismissable: true,
      });
      return;
    }

    // Open the PDF file
    this._openPdfDirect(pdfPath);
  },

  openPdfExternal() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      atom.notifications.addWarning("Not a LaTeX file");
      return;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;
    const pdfPath = this.getPdfPathForFile(filePath);

    // Check if build is in progress
    if (this.checkBuildStatus(rootPath)) {
      this.waitForBuildAndOpen(rootPath, pdfPath, true);
      return;
    }

    // Check if PDF exists
    const fs = require("fs");
    if (!fs.existsSync(pdfPath)) {
      atom.notifications.addWarning("PDF file not found", {
        detail: `Expected file: ${pdfPath}\n\nPlease compile the LaTeX file first.`,
        dismissable: true,
      });
      return;
    }

    // Open the PDF file externally
    this._openPdfExternalDirect(pdfPath);
  },

  cleanLinter() {
    if (this.linterProvider) {
      this.linterProvider.clearMessages();
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] Linter messages cleared");
      }
    }
  },

  openLatexmkrc() {
    const latexmkrcPath = getLatexmkrcPath();
    const result = createLatexmkrc(latexmkrcPath);

    if (!result.success) {
      atom.notifications.addError("Failed to create latexmkrc", {
        detail: result.error,
        dismissable: true,
      });
      return;
    }

    // Open the file in the editor
    atom.workspace
      .open(latexmkrcPath)
      .then(() => {
        if (atom.config.get("latex-tools.debug")) {
          console.log(`[LaTeX Tools] Opened latexmkrc: ${latexmkrcPath}`);
        }
      })
      .catch((error) => {
        atom.notifications.addError("Failed to open latexmkrc", {
          detail: error.message,
          dismissable: true,
        });
      });
  },

  showObservedFiles() {
    if (this.observedFilesList) {
      this.observedFilesList.show();
    }
  },

  updateObservedFilesStatus() {
    if (this.observedFilesStatusView) {
      this.observedFilesStatusView.setCount(this.getCompileOnSaveFiles().length);
    }
  },

  clearCompileOnSaveFiles() {
    const count = this.compileOnSaveFiles.size;
    if (count === 0) {
      return false;
    }

    for (const info of this.compileOnSaveFiles.values()) {
      if (info.disposable) {
        info.disposable.dispose();
      }
      if (info.timeout) {
        clearTimeout(info.timeout);
      }
    }

    this.compileOnSaveFiles.clear();
    this.updateObservedFilesStatus();
    if (this.observedFilesList) {
      this.observedFilesList.update();
    }
    if (this.statusBarView) {
      this.statusBarView.setCompileOnSave(false);
    }

    atom.notifications.addInfo(`Cleared ${count} observed file${count === 1 ? "" : "s"}`);
    return true;
  },

  clean() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      atom.notifications.addWarning("Not a LaTeX file");
      return;
    }

    this.cleanFile(this.getRootFilePath(filePath) || filePath);
  },

  cleanFile(filePath) {
    const fs = require("fs");
    const fileDir = path.dirname(filePath);
    const baseName = path.basename(filePath, ".tex");

    // Get auxiliary file extensions/patterns from config
    const cleanPatterns = atom.config.get("latex-tools.cleanExtensions") || [];

    if (cleanPatterns.length === 0) {
      atom.notifications.addWarning("No auxiliary file extensions configured", {
        detail: "Please configure auxiliary file extensions in latex-tools settings.",
        dismissable: true,
      });
      return;
    }

    let deletedFiles = [];
    let failedFiles = [];

    // Read all files in the directory
    let allFiles;
    try {
      allFiles = fs.readdirSync(fileDir);
    } catch (error) {
      atom.notifications.addError("Failed to read directory", {
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
              if (!file.endsWith(".tex") && !file.endsWith(".pdf")) {
                fs.unlinkSync(fullPath);
                deletedFiles.push(file);
                if (atom.config.get("latex-tools.debug")) {
                  console.log(`[LaTeX Tools] Deleted: ${fullPath}`);
                }
              }
            } catch (error) {
              failedFiles.push(file);
              if (atom.config.get("latex-tools.debug")) {
                console.error(`[LaTeX Tools] Failed to delete ${fullPath}:`, error);
              }
            }
          }
        }
      } else {
        // Simple extension matching (legacy behavior)
        const auxFile = path.join(fileDir, `${baseName}.${pattern}`);
        if (fs.existsSync(auxFile)) {
          try {
            fs.unlinkSync(auxFile);
            deletedFiles.push(`${baseName}.${pattern}`);
            if (atom.config.get("latex-tools.debug")) {
              console.log(`[LaTeX Tools] Deleted: ${auxFile}`);
            }
          } catch (error) {
            failedFiles.push(`${baseName}.${pattern}`);
            if (atom.config.get("latex-tools.debug")) {
              console.error(`[LaTeX Tools] Failed to delete ${auxFile}:`, error);
            }
          }
        }
      }
    }

    // Show results
    if (deletedFiles.length > 0) {
      atom.notifications.addSuccess(`Cleaned ${deletedFiles.length} auxiliary file(s)`, {
        detail: deletedFiles.join("\n"),
        dismissable: true,
      });
    } else {
      atom.notifications.addInfo("No auxiliary files found to clean");
    }

    if (failedFiles.length > 0) {
      atom.notifications.addWarning(`Failed to delete ${failedFiles.length} file(s)`, {
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

  killProcess(childProcess) {
    if (!childProcess) return;

    // Kill the process tree (especially important on Windows)
    if (process.platform === "win32") {
      // On Windows, use taskkill to kill the entire process tree
      const taskkill = spawn("taskkill", ["/pid", childProcess.pid.toString(), "/T", "/F"]);
      taskkill.on("exit", () => {
        if (atom.config.get("latex-tools.debug")) {
          console.log(`[LaTeX Tools] Process tree killed for PID ${childProcess.pid}`);
        }
      });
    } else {
      // On Unix-like systems, kill the process group
      try {
        process.kill(-childProcess.pid, "SIGTERM");
      } catch (error) {
        if (atom.config.get("latex-tools.debug")) {
          console.error("[LaTeX Tools] Failed to kill process group:", error);
        }
        childProcess.kill("SIGTERM");
      }
    }
  },

  interrupt() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      atom.notifications.addWarning("Not a LaTeX file");
      return;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;
    const processInfo = this.buildProcesses.get(rootPath);
    if (!processInfo) {
      atom.notifications.addInfo("No build process running for this file");
      return;
    }

    const fileName = path.basename(rootPath);

    // Kill the process
    this.killProcess(processInfo.process);

    // Remove from tracking
    this.buildProcesses.delete(rootPath);

    // Update status
    this.setBuildState(rootPath, "idle", "Build interrupted");
    this.statusBarView.setStatus("idle", "Build interrupted");

    // Notify build service
    if (this.buildService) {
      this.buildService.failBuild(rootPath, "Build interrupted by user", "");
    }

    // Clear linter messages
    this.cleanLinter();

    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
    }
  },

  interruptAll() {
    if (this.buildProcesses.size === 0) {
      atom.notifications.addInfo("No build processes running");
      return;
    }

    const count = this.buildProcesses.size;
    const fileNames = [];

    // Kill all processes
    for (const [filePath, processInfo] of this.buildProcesses) {
      const fileName = path.basename(filePath);
      fileNames.push(fileName);

      // Kill the process
      this.killProcess(processInfo.process);

      // Update status
      this.setBuildState(filePath, "idle", "Build interrupted");

      // Notify build service
      if (this.buildService) {
        this.buildService.failBuild(filePath, "Build interrupted by user", "");
      }

      if (atom.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
      }
    }

    // Clear all processes
    this.buildProcesses.clear();

    // Update status bar for current file
    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      const filePath = editor.getPath();
      if (filePath && filePath.endsWith(".tex")) {
        this.statusBarView.setStatus("idle", "Build interrupted");
      }
    }

    // Clear linter messages
    this.cleanLinter();

    atom.notifications.addWarning(`Interrupted ${count} build process(es)`, {
      detail: fileNames.join("\n"),
    });
  },

  killAndClean() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      atom.notifications.addWarning("Not a LaTeX file");
      return;
    }

    // First, interrupt any running build for this file
    const rootPath = this.getRootFilePath(filePath) || filePath;
    const processInfo = this.buildProcesses.get(rootPath);
    if (processInfo) {
      const fileName = path.basename(rootPath);

      // Kill the process
      this.killProcess(processInfo.process);

      // Remove from tracking
      this.buildProcesses.delete(rootPath);

      // Update status
      this.setBuildState(rootPath, "idle", "Build interrupted");
      this.statusBarView.setStatus("idle", "Build interrupted");

      // Notify build service
      if (this.buildService) {
        this.buildService.failBuild(rootPath, "Build interrupted by user", "");
      }

      if (atom.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
      }

      atom.notifications.addInfo(`Build interrupted for ${fileName}`);
    }

    // Then run the clean command
    this.clean();
  },

  toggleCompileOnSave() {
    let editor = atom.workspace.getActiveTextEditor();
    if (editor && isPending(editor)) {
      const pane = atom.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    let filePath = editor?.getPath();
    if (!filePath) {
      editor = null;
      filePath = this.currentTexFile;
    }

    if (!filePath) {
      atom.notifications.addWarning("No LaTeX file available");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      if (this.currentTexFile) {
        editor = null;
        filePath = this.currentTexFile;
      } else {
        atom.notifications.addWarning("Not a LaTeX file");
        return;
      }
    }

    const fileName = path.basename(filePath);
    const enabled = this.isCompileOnSaveEnabledForFile(filePath);

    if (enabled) {
      const changed = this.setCompileOnSaveForFile(filePath, false, editor);
      if (!changed) {
        return;
      }
      atom.notifications.addInfo(`Compile on save disabled for ${fileName}`);

      if (atom.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Compile on save disabled for ${fileName}`);
      }
    } else {
      const changed = this.setCompileOnSaveForFile(filePath, true, editor);
      if (!changed) {
        atom.notifications.addWarning("Failed to enable compile on save", {
          detail: `Could not observe ${filePath}`,
          dismissable: true,
        });
        return;
      }
      atom.notifications.addSuccess(`Compile on save enabled for ${fileName}`);

      if (atom.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Compile on save enabled for ${fileName}`);
      }
    }

    // Update status bar to reflect compile-on-save state
    if (editor) {
      this.updateStatusBarVisibility(editor, "editor");
    } else {
      this.statusBarView.setCompileOnSave(this.isCompileOnSaveEnabledForFile(filePath));
    }
  },

  disableCompileOnSave(editorId) {
    const editor = atom.workspace.getTextEditors().find((item) => item.id === editorId);
    if (editor) {
      this.setCompileOnSaveForFile(editor.getPath(), false, editor);
    }
  },

  isCompileOnSaveEnabled(editor) {
    if (!editor) return false;
    return this.isCompileOnSaveEnabledForFile(editor.getPath());
  },

  compileFile(editor) {
    // Compile a specific editor's file (used by compile-on-save)
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath || !filePath.endsWith(".tex")) return;

    this.compileFilePath(filePath);
  },

  compileFilePath(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) return;

    const rootPath = this.getRootFilePath(filePath) || filePath;

    if (this.checkBuildStatus(rootPath)) {
      if (atom.config.get("latex-tools.debug")) {
        console.log(
          `[LaTeX Tools] Skipping compile-on-save, build already in progress for ${path.basename(
            rootPath,
          )}`,
        );
      }
      return;
    }

    this.runCompilation(rootPath);
  },

  // Status bar click handlers - work with both text editors and PDF viewers
  compileFromStatusBar() {
    const editor = atom.workspace.getActiveTextEditor();
    const filePath = editor?.getPath();

    if (filePath && filePath.endsWith(".tex")) {
      // Active .tex editor - use standard compile
      this.compile();
    } else if (this.currentTexFile) {
      // PDF viewer or other item - use tracked tex file
      const rootPath = this.getRootFilePath(this.currentTexFile) || this.currentTexFile;
      if (this.checkBuildStatus(rootPath)) {
        atom.notifications.addWarning("Build already in progress", {
          detail: `${path.basename(rootPath)} is currently being compiled.`,
          dismissable: true,
        });
        return;
      }
      // Save the tex file if it's open and modified
      const editors = atom.workspace.getTextEditors();
      const texEditor = editors.find((e) => e.getPath() === rootPath);
      if (texEditor && texEditor.isModified()) {
        texEditor.save();
      }
      this.runCompilation(rootPath);
    } else {
      atom.notifications.addWarning("No LaTeX file available");
    }
  },

  openPdfFromStatusBar() {
    const editor = atom.workspace.getActiveTextEditor();
    const filePath = editor?.getPath();
    const fs = require("fs");

    if (filePath && filePath.endsWith(".tex")) {
      // Active .tex editor - open PDF on the right
      const pdfPath = this.getPdfPathForFile(filePath);

      if (!fs.existsSync(pdfPath)) {
        atom.notifications.addWarning("PDF file not found", {
          detail: `Expected file: ${pdfPath}\n\nPlease compile the LaTeX file first.`,
          dismissable: true,
        });
        return;
      }
      this._openPdfDirect(pdfPath, { split: "right" });
    } else if (this.currentTexFile) {
      // PDF viewer - open the corresponding .tex file on the left
      if (!fs.existsSync(this.currentTexFile)) {
        atom.notifications.addWarning("TeX file not found", {
          detail: `Expected file: ${this.currentTexFile}`,
          dismissable: true,
        });
        return;
      }
      atom.workspace.open(this.currentTexFile, { split: "left", searchAllPanes: true });
    } else {
      atom.notifications.addWarning("No LaTeX file available");
    }
  },

  killAndCleanFromStatusBar() {
    const editor = atom.workspace.getActiveTextEditor();
    const filePath = editor?.getPath();

    if (filePath && filePath.endsWith(".tex")) {
      // Active .tex editor - use standard killAndClean
      this.killAndClean();
    } else if (this.currentTexFile) {
      // PDF viewer or other item - kill/clean tracked tex file
      const rootPath = this.getRootFilePath(this.currentTexFile) || this.currentTexFile;
      const processInfo = this.buildProcesses.get(rootPath);
      if (processInfo) {
        const fileName = path.basename(rootPath);
        this.killProcess(processInfo.process);
        this.buildProcesses.delete(rootPath);
        this.setBuildState(rootPath, "idle", "Build interrupted");
        this.statusBarView.setStatus("idle", "Build interrupted");
        if (this.buildService) {
          this.buildService.failBuild(rootPath, "Build interrupted by user", "");
        }
        atom.notifications.addInfo(`Build interrupted for ${fileName}`);
      }
      // Run clean for the tracked file
      this.cleanFile(rootPath);
    } else {
      atom.notifications.addWarning("No LaTeX file available");
    }
  },

  compile() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      atom.notifications.addWarning("No active editor");
      return;
    }

    if (isPending(editor)) {
      const pane = atom.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    const filePath = editor.getPath();
    if (!filePath) {
      atom.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      atom.notifications.addWarning("Not a LaTeX file");
      return;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;

    // Check if already building this file
    if (this.checkBuildStatus(rootPath)) {
      atom.notifications.addWarning("Build already in progress", {
        detail: `${path.basename(rootPath)} is currently being compiled.`,
        dismissable: true,
      });
      return;
    }

    // Save file before compiling
    if (editor.isModified()) {
      editor.save();
    }

    const rootEditor = atom.workspace.getTextEditors().find((e) => e.getPath() === rootPath);
    if (rootEditor && rootEditor !== editor && rootEditor.isModified()) {
      rootEditor.save();
    }

    // Run the compilation
    this.runCompilation(rootPath);
  },

  runCompilation(filePath) {
    filePath = this.getRootFilePath(filePath) || filePath;
    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);

    // Build latexmk arguments based on config
    const args = [
      "-bibtex", // Run bibtex when needed
      "-interaction=nonstopmode", // Don't stop on errors
      "-file-line-error", // Better error messages
    ];

    // Select LaTeX engine (magic comment overrides config)
    const magicEngine = detectEngineFromMagicComment(filePath);
    const engine = magicEngine || atom.config.get("latex-tools.latexEngine") || "pdflatex";
    if (engine === "xelatex") {
      args.push("-xelatex");
    } else if (engine === "lualatex") {
      args.push("-lualatex");
    } else {
      args.push("-pdf"); // pdflatex (default)
    }

    // Set output verbosity
    const verbosity = atom.config.get("latex-tools.outputVerbosity") || "default";
    if (verbosity === "silent") {
      args.push("-silent");
    } else if (verbosity === "quiet") {
      args.push("-quiet");
    }

    // Add SyncTeX if enabled
    if (atom.config.get("latex-tools.enableSynctex")) {
      args.push("-synctex=1");
    }

    // Add shell escape if enabled
    if (atom.config.get("latex-tools.shellEscape")) {
      args.push("-shell-escape");
    }

    // Add clean option if enabled
    if (atom.config.get("latex-tools.cleanAuxFiles")) {
      args.push("-c");
    }

    // Add the file name as the last argument
    args.push(fileName);

    // Track build start time
    const startTime = Date.now();

    // Update status bar and store build state
    this.setBuildState(filePath, "building", `Compiling ${fileName}`, {
      startTime,
    });

    if (this.isStatusBarActiveFor(filePath)) {
      this.statusBarView.setStatus("building", `Compiling ${fileName}`);
    }

    // Clear linter messages at start of compilation
    this.linterProvider.clearMessages();

    // Notify user about compile start
    atom.notifications.addInfo(`Compiling ${fileName}...`);

    // Update panel to show building state
    if (this.latexPanel) {
      this.latexPanel.setBuilding(filePath);
    }

    // Notify build service
    if (this.buildService) {
      this.buildService.startBuild(filePath);
    }

    let stdout = "";
    let stderr = "";

    // Use child_process.spawn for better process control
    const latexmkPath = atom.config.get("latex-tools.latexmkPath") || "latexmk";
    const childProcess = spawn(latexmkPath, args, {
      cwd: fileDir,
      shell: false,
      // On Unix-like systems, create a new process group for easier termination
      detached: process.platform !== "win32",
    });

    // Store the process reference for interruption
    this.buildProcesses.set(filePath, {
      process: childProcess,
      startTime: Date.now(),
    });

    // Capture stdout
    childProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    // Capture stderr
    childProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle process exit
    childProcess.on("exit", (code, signal) => {
      // Calculate elapsed time
      const elapsedTime = Date.now() - startTime;

      // Remove from tracking
      this.buildProcesses.delete(filePath);

      // Check if process was killed by signal (interrupted)
      if (signal) {
        if (atom.config.get("latex-tools.debug")) {
          console.log(`[LaTeX Tools] Process terminated by signal: ${signal}`);
        }
        return; // Don't show success/error notifications for interrupted builds
      }

      if (code === 0) {
        this.setBuildState(filePath, "success", `${fileName} compiled successfully`, {
          startTime,
          elapsedTime,
        });
        // Update status bar if this file is still active (editor or PDF viewer)
        if (this.isStatusBarActiveFor(filePath)) {
          this.statusBarView.setStatus("success", `${fileName} compiled successfully`);
          this.statusBarView.showElapsedTime(elapsedTime);
        }

        // Notify user
        atom.notifications.addSuccess(`${fileName} compiled successfully`, {
          detail: `Completed in ${Math.floor(elapsedTime / 1000)}s`,
        });

        if (atom.config.get("latex-tools.debug")) {
          console.log(`LaTeX compilation completed in ${elapsedTime}ms`);
        }

        // Parse log file and update panel
        this.parseLogFile(filePath);

        // Notify build service of success
        if (this.buildService) {
          this.buildService.finishBuild(filePath, stdout, elapsedTime);
        }
      } else {
        const exitCodeDesc = getExitCodeDescription(code);
        this.setBuildState(
          filePath,
          "error",
          `Compilation failed: ${exitCodeDesc} (exit code ${code})`,
          { startTime, elapsedTime },
        );
        // Update status bar if this file is still active (editor or PDF viewer)
        if (this.isStatusBarActiveFor(filePath)) {
          this.statusBarView.setStatus("error", `Compilation failed: ${exitCodeDesc} (${code})`);
          this.statusBarView.showElapsedTime(elapsedTime);
        }

        // Notify user
        atom.notifications.addError(`${fileName} compilation failed`, {
          detail: `Exit code ${code}: ${exitCodeDesc}\nCompleted in ${Math.floor(elapsedTime / 1000)}s`,
          dismissable: true,
        });

        if (atom.config.get("latex-tools.debug")) {
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
            if (atom.config.get("latex-tools.debug")) {
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
        if (this.buildService) {
          this.buildService.updateMessages(filePath, messages);
          this.buildService.failBuild(
            filePath,
            `${exitCodeDesc} (exit code ${code})`,
            stderr || stdout,
          );
        }
      }
    });

    // Handle process errors (e.g., command not found)
    childProcess.on("error", (error) => {
      // Calculate elapsed time
      const elapsedTime = Date.now() - startTime;

      // Remove from tracking
      this.buildProcesses.delete(filePath);

      this.setBuildState(filePath, "error", "latexmk not found", {
        startTime,
        elapsedTime,
      });
      // Update status bar if this file is still active (editor or PDF viewer)
      if (this.isStatusBarActiveFor(filePath)) {
        this.statusBarView.setStatus("error", "latexmk not found");
        this.statusBarView.showElapsedTime(elapsedTime);
      }
      atom.notifications.addError("Failed to run latexmk", {
        detail: `Make sure latexmk is installed and in your PATH.\n\nError: ${error.message}`,
        dismissable: true,
      });

      // Notify build service of failure
      if (this.buildService) {
        this.buildService.failBuild(filePath, "latexmk not found", error.message);
      }
    });
  },

  // ============================================
  // API DELEGATION METHODS
  // These methods are called by BuildService to delegate actions
  // ============================================

  /**
   * Interrupt a specific file's build (API method)
   * @param {string} filePath - Path to the .tex file
   * @returns {boolean} True if a build was interrupted
   */
  interruptFile(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return false;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;
    const processInfo = this.buildProcesses.get(rootPath);
    if (!processInfo) {
      return false;
    }

    const fileName = path.basename(rootPath);

    // Kill the process
    this.killProcess(processInfo.process);

    // Remove from tracking
    this.buildProcesses.delete(rootPath);

    // Update status
    this.setBuildState(rootPath, "idle", "Build interrupted");

    // Update status bar if this file is active (editor or PDF viewer)
    if (this.isStatusBarActiveFor(rootPath)) {
      this.statusBarView.setStatus("idle", "Build interrupted");
    }

    // Notify build service
    if (this.buildService) {
      this.buildService.failBuild(rootPath, "Build interrupted by user", "");
    }

    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
    }

    return true;
  },

  /**
   * Interrupt all builds (API method)
   * @returns {number} Number of builds interrupted
   */
  interruptAllBuilds() {
    const count = this.buildProcesses.size;
    if (count === 0) {
      return 0;
    }

    for (const [filePath, processInfo] of this.buildProcesses) {
      this.killProcess(processInfo.process);
      this.setBuildState(filePath, "idle", "Build interrupted");

      if (this.buildService) {
        this.buildService.failBuild(filePath, "Build interrupted by user", "");
      }
    }

    this.buildProcesses.clear();

    // Update status bar for current file
    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      const filePath = editor.getPath();
      if (filePath && filePath.endsWith(".tex")) {
        this.statusBarView.setStatus("idle", "Build interrupted");
      }
    }

    this.cleanLinter();

    return count;
  },

  /**
   * Get parsed log messages (API method)
   * @param {string} [filePath] - Path to the .tex file
   * @returns {Array} Array of message objects
   */
  getLogMessages(filePath = null) {
    if (!filePath) {
      const editor = atom.workspace.getActiveTextEditor();
      if (editor) {
        filePath = editor.getPath();
      }
    }

    if (!filePath || !filePath.endsWith(".tex")) {
      return [];
    }

    filePath = this.getRootFilePath(filePath) || filePath;

    // Parse the log file
    const fs = require("fs");
    const logPath = filePath.replace(/\.tex$/, ".log");

    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      const logContent = fs.readFileSync(logPath, "utf8");
      return this.logParser.parse(logContent, filePath);
    } catch (error) {
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] Failed to parse log file:", error);
      }
      return [];
    }
  },

  /**
   * Get log message statistics (API method)
   * @param {string} [filePath] - Path to the .tex file
   * @returns {Object} Statistics object
   */
  getLogStatistics(filePath = null) {
    const messages = this.getLogMessages(filePath);
    return {
      total: messages.length,
      errors: messages.filter((m) => m.severity === "error").length,
      warnings: messages.filter((m) => m.severity === "warning").length,
      info: messages.filter((m) => m.severity === "info").length,
      hints: messages.filter((m) => m.severity === "hint").length,
    };
  },

  /**
   * Open PDF for a file (API method)
   * @param {string} filePath - Path to the .tex file
   * @returns {Promise<boolean>} True if successful
   */
  async openPdfForFile(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return false;
    }

    const pdfPath = this.getPdfPathForFile(filePath);
    const fs = require("fs");

    if (!fs.existsSync(pdfPath)) {
      return false;
    }

    try {
      await atom.workspace.open(pdfPath, { searchAllPanes: true });
      return true;
    } catch (error) {
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] Failed to open PDF:", error);
      }
      return false;
    }
  },

  /**
   * Open PDF externally for a file (API method)
   * @param {string} filePath - Path to the .tex file
   * @returns {Promise<boolean>} True if successful
   */
  async openPdfExternalForFile(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return false;
    }

    if (!this.openExternalService) {
      return false;
    }

    const pdfPath = this.getPdfPathForFile(filePath);
    const fs = require("fs");

    if (!fs.existsSync(pdfPath)) {
      return false;
    }

    try {
      await this.openExternalService.openExternal(pdfPath);
      return true;
    } catch (error) {
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] Failed to open PDF externally:", error);
      }
      return false;
    }
  },

  getCompileOnSaveKey(filePath) {
    return normalizePathForTex(path.resolve(filePath));
  },

  isCompileOnSaveEnabledForFile(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return false;
    }

    return this.compileOnSaveFiles.has(this.getCompileOnSaveKey(filePath));
  },

  setCompileOnSaveForFile(filePath, enabled, editor = null) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return false;
    }

    const key = this.getCompileOnSaveKey(filePath);
    const currentlyEnabled = this.compileOnSaveFiles.has(key);

    if (enabled === currentlyEnabled) {
      return false;
    }

    if (!enabled) {
      const info = this.compileOnSaveFiles.get(key);
      if (info?.disposable) {
        info.disposable.dispose();
      }
      if (info?.timeout) {
        clearTimeout(info.timeout);
      }
      this.compileOnSaveFiles.delete(key);
      this.updateObservedFilesStatus();

      if (this.buildService) {
        this.buildService.emitCompileOnSaveChange(filePath, false, editor);
      }

      return true;
    }

    const resolvedFilePath = path.resolve(filePath);
    const info = {
      filePath: resolvedFilePath,
      timeout: null,
      disposable: null,
      file: null,
    };

    const scheduleCompile = () => {
      if (info.timeout) {
        clearTimeout(info.timeout);
      }

      info.timeout = setTimeout(() => {
        info.timeout = null;
        this.compileFilePath(filePath);
      }, 150);
    };

    try {
      // The synchronous atom `File` was removed from Lumine; `watchFile` is the
      // async replacement. It owns a native watcher that must be disposed —
      // the event subscription alone does not stop it.
      info.file = watchFile(resolvedFilePath);
      info.disposable = new CompositeDisposable(
        new Disposable(() => info.file.dispose()),
        info.file.onDidChange(scheduleCompile),
      );
    } catch (error) {
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] Failed to observe compile-on-save file:", error);
      }
      return false;
    }

    this.compileOnSaveFiles.set(key, info);
    this.updateObservedFilesStatus();

    if (this.buildService) {
      this.buildService.emitCompileOnSaveChange(filePath, true, editor);
    }

    return true;
  },

  /**
   * Set compile-on-save for an editor (API method)
   * @param {TextEditor} editor - The editor instance
   * @param {boolean} enabled - Whether to enable
   * @returns {boolean} True if state was changed
   */
  setCompileOnSaveForEditor(editor, enabled) {
    if (!editor) {
      return false;
    }

    const filePath = editor.getPath();
    if (!filePath || !filePath.endsWith(".tex")) {
      return false;
    }

    const changed = this.setCompileOnSaveForFile(filePath, enabled, editor);

    // Update status bar
    this.updateStatusBarVisibility(editor, "editor");

    return changed;
  },

  /**
   * Get all editors with compile-on-save enabled (API method)
   * @returns {Array<TextEditor>}
   */
  getCompileOnSaveEditors() {
    const observedKeys = new Set(this.compileOnSaveFiles.keys());
    return atom.workspace.getTextEditors().filter((editor) => {
      const filePath = editor.getPath();
      return filePath && observedKeys.has(this.getCompileOnSaveKey(filePath));
    });
  },

  /**
   * Get all file paths with compile-on-save enabled.
   * @returns {Array<string>}
   */
  getCompileOnSaveFiles() {
    return Array.from(this.compileOnSaveFiles.values()).map((info) => info.filePath);
  },

  /**
   * Resolve a .tex path to the file that should be built/viewed.
   * @param {string} filePath - Path to a .tex file
   * @returns {string|null} Build root path, or null if invalid
   */
  getRootFilePath(filePath) {
    return this.resolveTexRoot(filePath);
  },

  /**
   * Get the root PDF path for a .tex file.
   * @param {string} filePath - Path to a .tex file
   * @returns {string|null} Root PDF path, or null if invalid
   */
  getPdfPathForFile(filePath) {
    const rootPath = this.getRootFilePath(filePath);
    return rootPath ? rootPath.replace(/\.tex$/, ".pdf") : null;
  },

  /**
   * Resolve the root .tex file for a source file.
   * @param {string} filePath - Path to a .tex file
   * @returns {string|null} Root .tex file path, or null if invalid
   */
  resolveTexRoot(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return null;
    }

    const fs = require("fs");

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

  /**
   * Find likely root documents that include a source file.
   * @param {string} filePath - Path to a .tex file
   * @returns {Array<string>} Candidate root .tex paths
   */
  findRootCandidatesForFile(filePath) {
    const fs = require("fs");
    const sourcePath = path.resolve(filePath);
    const sourceDir = path.dirname(sourcePath);
    const projectPaths =
      typeof atom !== "undefined" && atom.project && atom.project.getPaths
        ? atom.project.getPaths().map((projectPath) => path.resolve(projectPath))
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
          if (normalizePathForTex(candidatePath) === normalizePathForTex(sourcePath)) {
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
          normalizePathForTex(candidatePath) === normalizePathForTex(sourcePath)
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

  /**
   * Forward SyncTeX: source to PDF (API method)
   * @param {string} texPath - Path to the .tex file
   * @param {number} line - Line number (1-based)
   * @param {number} column - Column number (0-based)
   * @returns {Promise<Object|null>} PDF location or null
   */
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
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] SyncTeX file not found:", syncPath);
      }
      return null;
    }

    try {
      const { execFileSync } = require("child_process");
      const synctexPath = atom.config.get("latex-tools.synctexPath") || "synctex";
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
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] SyncTeX forward sync failed:", error);
      }
      return null;
    }
  },

  /**
   * Backward SyncTeX: PDF to source (API method)
   * @param {string} pdfPath - Path to the .pdf file
   * @param {number} page - Page number (1-based)
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @returns {Promise<Object|null>} Source location or null
   */
  async syncToSource(pdfPath, page, x, y) {
    if (!pdfPath || !pdfPath.endsWith(".pdf")) {
      return null;
    }

    const syncPath = pdfPath.replace(/\.pdf$/, ".synctex.gz");
    const fs = require("fs");

    if (!fs.existsSync(syncPath)) {
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] SyncTeX file not found:", syncPath);
      }
      return null;
    }

    try {
      const { execSync } = require("child_process");
      const result = execSync(`synctex edit -o "${page}:${x}:${y}:${pdfPath}"`, {
        encoding: "utf8",
        timeout: 5000,
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
      if (atom.config.get("latex-tools.debug")) {
        console.error("[LaTeX Tools] SyncTeX backward sync failed:", error);
      }
      return null;
    }
  },

  /**
   * Forward SyncTeX command: jumps from editor cursor to PDF position.
   * Uses syncToPdf() utility, then opens/scrolls the PDF viewer.
   */
  async synctex() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;

    const file = editor.getPath();
    if (!file || !file.endsWith(".tex")) return;

    const position = editor.getLastCursor().getBufferPosition();
    const result = await this.syncToPdf(file, position.row + 1, position.column + 1);
    if (!result) return;

    const pdfFile = result.pdfPath || file.replace(/\.tex$/, ".pdf");

    // open() returns existing viewer or creates new one
    const viewer = await atom.workspace.open(`${pdfFile}`, {
      split: "right",
      searchAllPanes: true,
    });

    // Wait for viewer to be ready if it was just created
    if (viewer.whenReady) {
      await viewer.whenReady();
    }

    // Scroll to precise position if viewer supports it
    if (viewer.scrollToPosition) {
      viewer.scrollToPosition(result.page - 1, result.x, result.y);
    }

    atom.views.getView(editor).focus();
  },
};
