const { Emitter } = require("atom");

/**
 * LaTeX Tools Build Service API
 *
 * This service provides a public API for other packages to interact with
 * latex-tools. It exposes build status, compilation control, log messages,
 * and compile-on-save functionality.
 *
 * @example
 * // In your package's main.js:
 * consumeLatexTools(service) {
 *   // Subscribe to build events
 *   service.onDidFinishBuild(({ file, output }) => {
 *     console.log(`Build finished: ${file}`);
 *   });
 *
 *   // Trigger a compilation
 *   service.compile('/path/to/file.tex');
 *
 *   // Get parsed log messages
 *   const messages = service.getMessages('/path/to/file.tex');
 * }
 */
module.exports = class BuildService {
  constructor() {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Creating BuildService");
    }
    this.emitter = new Emitter();
    this.buildingFiles = new Map(); // Track status per file
    this.mainModule = null; // Reference to main module for delegated methods
  }

  /**
   * Set reference to main module (called during activation)
   * @private
   */
  setMainModule(mainModule) {
    this.mainModule = mainModule;
  }

  /**
   * Resolve a path through the main module's root discovery.
   * @private
   */
  resolveRoot(filePath) {
    if (!this.mainModule || !filePath || !filePath.endsWith(".tex")) {
      return filePath;
    }

    return this.mainModule.getRootFilePath(filePath) || filePath;
  }

  // ============================================
  // BUILD EVENTS
  // ============================================

  /**
   * Subscribe to build start events
   * @param {Function} callback - Called with { file: string }
   * @returns {Disposable}
   */
  onDidStartBuild(callback) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: Registered onDidStartBuild callback");
    }
    return this.emitter.on("did-start-build", callback);
  }

  /**
   * Subscribe to successful build completion events
   * @param {Function} callback - Called with { file: string, output: string, elapsedTime: number }
   * @returns {Disposable}
   */
  onDidFinishBuild(callback) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: Registered onDidFinishBuild callback");
    }
    return this.emitter.on("did-finish-build", callback);
  }

  /**
   * Subscribe to build failure events
   * @param {Function} callback - Called with { file: string, error: string, output: string }
   * @returns {Disposable}
   */
  onDidFailBuild(callback) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: Registered onDidFailBuild callback");
    }
    return this.emitter.on("did-fail-build", callback);
  }

  /**
   * Subscribe to any build status change
   * @param {Function} callback - Called with { file: string, status: 'idle'|'building'|'success'|'error', error?: string }
   * @returns {Disposable}
   */
  onDidChangeBuildStatus(callback) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: Registered onDidChangeBuildStatus callback");
    }
    return this.emitter.on("did-change-build-status", callback);
  }

  /**
   * Subscribe to log messages update events
   * @param {Function} callback - Called with { file: string, messages: Array }
   * @returns {Disposable}
   */
  onDidUpdateMessages(callback) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: Registered onDidUpdateMessages callback");
    }
    return this.emitter.on("did-update-messages", callback);
  }

  /**
   * Subscribe to compile-on-save state changes
   * @param {Function} callback - Called with { file: string, enabled: boolean, editor?: TextEditor }
   * @returns {Disposable}
   */
  onDidChangeCompileOnSave(callback) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: Registered onDidChangeCompileOnSave callback");
    }
    return this.emitter.on("did-change-compile-on-save", callback);
  }

  // ============================================
  // BUILD STATUS
  // ============================================

  /**
   * Get build status for a file or all files
   * @param {string} [filePath] - Optional file path. If omitted, returns global status.
   * @returns {Object} Status object with status, file, and optionally buildingCount and files array
   */
  getStatus(filePath = null) {
    if (filePath) {
      const rootPath = this.resolveRoot(filePath);
      const fileStatus = this.buildingFiles.get(rootPath);
      return {
        status: fileStatus ? fileStatus.status : "idle",
        file: rootPath,
        startTime: fileStatus?.startTime || null,
        endTime: fileStatus?.endTime || null,
        error: fileStatus?.error || null,
      };
    }
    const buildingCount = Array.from(this.buildingFiles.values()).filter(
      (s) => s.status === "building",
    ).length;
    return {
      status: buildingCount > 0 ? "building" : "idle",
      buildingCount: buildingCount,
      files: Array.from(this.buildingFiles.entries()).map(([file, data]) => ({
        file,
        status: data.status,
        startTime: data.startTime || null,
        endTime: data.endTime || null,
      })),
    };
  }

  /**
   * Check if a specific file is currently building
   * @param {string} filePath - Path to the .tex file
   * @returns {boolean}
   */
  isBuilding(filePath) {
    const rootPath = this.resolveRoot(filePath);
    const fileStatus = this.buildingFiles.get(rootPath);
    return fileStatus && fileStatus.status === "building";
  }

  /**
   * Check if any build is currently in progress
   * @returns {boolean}
   */
  isAnyBuilding() {
    return Array.from(this.buildingFiles.values()).some((s) => s.status === "building");
  }

  // ============================================
  // BUILD CONTROL
  // ============================================

  /**
   * Compile a LaTeX file
   * @param {string} filePath - Path to the .tex file to compile
   * @returns {boolean} True if compilation was started, false if already building or invalid file
   */
  compile(filePath) {
    if (!this.mainModule) {
      console.error("[LaTeX Tools] BuildService: Main module not available");
      return false;
    }

    if (!filePath || !filePath.endsWith(".tex")) {
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] BuildService: Invalid file path for compile");
      }
      return false;
    }

    const rootPath = this.resolveRoot(filePath);

    if (this.isBuilding(rootPath)) {
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] BuildService: Build already in progress");
      }
      return false;
    }

    this.mainModule.runCompilation(rootPath);
    return true;
  }

  /**
   * Interrupt a specific build
   * @param {string} filePath - Path to the .tex file
   * @returns {boolean} True if build was interrupted, false if no build was running
   */
  interrupt(filePath) {
    if (!this.mainModule) {
      console.error("[LaTeX Tools] BuildService: Main module not available");
      return false;
    }

    return this.mainModule.interruptFile(this.resolveRoot(filePath));
  }

  /**
   * Interrupt all running builds
   * @returns {number} Number of builds that were interrupted
   */
  interruptAll() {
    if (!this.mainModule) {
      console.error("[LaTeX Tools] BuildService: Main module not available");
      return 0;
    }

    return this.mainModule.interruptAllBuilds();
  }

  // ============================================
  // LOG MESSAGES
  // ============================================

  /**
   * Get parsed log messages for a file
   * @param {string} [filePath] - Path to the .tex file. If omitted, returns messages for active editor.
   * @returns {Array} Array of message objects with severity, excerpt, location
   */
  getMessages(filePath = null) {
    if (!this.mainModule) {
      return [];
    }

    return this.mainModule.getLogMessages(filePath);
  }

  /**
   * Get message statistics for a file
   * @param {string} [filePath] - Path to the .tex file
   * @returns {Object} Statistics with total, errors, warnings, info counts
   */
  getMessageStatistics(filePath = null) {
    if (!this.mainModule) {
      return { total: 0, errors: 0, warnings: 0, info: 0 };
    }

    return this.mainModule.getLogStatistics(filePath);
  }

  // ============================================
  // OUTPUT FILES
  // ============================================

  /**
   * Get the output PDF path for a tex file
   * @param {string} filePath - Path to the .tex file
   * @returns {string|null} Path to the PDF file, or null if not found
   */
  getOutputPath(filePath) {
    if (!filePath || !filePath.endsWith(".tex")) {
      return null;
    }

    const pdfPath = this.mainModule
      ? this.mainModule.getPdfPathForFile(filePath)
      : filePath.replace(/\.tex$/, ".pdf");
    const fs = require("fs");
    return fs.existsSync(pdfPath) ? pdfPath : null;
  }

  /**
   * Open the PDF for a tex file in the workspace
   * @param {string} filePath - Path to the .tex file
   * @returns {Promise<boolean>} True if PDF was opened successfully
   */
  async openPdf(filePath) {
    if (!this.mainModule) {
      return false;
    }

    return this.mainModule.openPdfForFile(filePath);
  }

  /**
   * Open the PDF for a tex file in external application
   * @param {string} filePath - Path to the .tex file
   * @returns {Promise<boolean>} True if PDF was opened successfully
   */
  async openPdfExternal(filePath) {
    if (!this.mainModule) {
      return false;
    }

    return this.mainModule.openPdfExternalForFile(filePath);
  }

  // ============================================
  // COMPILE ON SAVE
  // ============================================

  /**
   * Enable or disable compile-on-save for an editor's file
   * @param {TextEditor} editor - The editor whose file should be observed
   * @param {boolean} enabled - Whether to enable compile-on-save for that file
   * @returns {boolean} True if the state was changed
   */
  setCompileOnSave(editor, enabled) {
    if (!this.mainModule || !editor) {
      return false;
    }

    return this.mainModule.setCompileOnSaveForEditor(editor, enabled);
  }

  /**
   * Check if compile-on-save is enabled for an editor's file
   * @param {TextEditor} editor - The editor instance
   * @returns {boolean}
   */
  isCompileOnSaveEnabled(editor) {
    if (!this.mainModule || !editor) {
      return false;
    }

    return this.mainModule.isCompileOnSaveEnabled(editor);
  }

  /**
   * Get all editors with compile-on-save enabled
   * @returns {Array<TextEditor>}
   */
  getCompileOnSaveEditors() {
    if (!this.mainModule) {
      return [];
    }

    return this.mainModule.getCompileOnSaveEditors();
  }

  /**
   * Get all file paths with compile-on-save enabled
   * @returns {Array<string>}
   */
  getCompileOnSaveFiles() {
    if (!this.mainModule) {
      return [];
    }

    return this.mainModule.getCompileOnSaveFiles();
  }

  // ============================================
  // SYNCTEX
  // ============================================

  /**
   * Perform forward SyncTeX (source to PDF)
   * @param {string} texPath - Path to the .tex file
   * @param {number} line - Line number (1-based)
   * @param {number} [column=0] - Column number (0-based)
   * @returns {Promise<Object|null>} PDF location { page, x, y, width, height } or null
   */
  async syncToPdf(texPath, line, column = 0) {
    if (!this.mainModule) {
      return null;
    }

    return this.mainModule.syncToPdf(texPath, line, column);
  }

  /**
   * Perform backward SyncTeX (PDF to source)
   * @param {string} pdfPath - Path to the .pdf file
   * @param {number} page - Page number (1-based)
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @returns {Promise<Object|null>} Source location { file, line, column } or null
   */
  async syncToSource(pdfPath, page, x, y) {
    if (!this.mainModule) {
      return null;
    }

    return this.mainModule.syncToSource(pdfPath, page, x, y);
  }

  // ============================================
  // INTERNAL METHODS (used by main.js)
  // ============================================

  /** @private */
  startBuild(filePath) {
    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] BuildService: startBuild(${filePath})`);
    }
    this.buildingFiles.set(filePath, {
      status: "building",
      startTime: Date.now(),
    });
    this.emitter.emit("did-start-build", { file: filePath });
    this.emitter.emit("did-change-build-status", {
      status: "building",
      file: filePath,
    });
  }

  /** @private */
  finishBuild(filePath, output, elapsedTime = null) {
    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] BuildService: finishBuild(${filePath})`);
    }
    const endTime = Date.now();
    this.buildingFiles.set(filePath, { status: "success", endTime });
    this.emitter.emit("did-finish-build", {
      file: filePath,
      output: output,
      elapsedTime: elapsedTime,
    });
    this.emitter.emit("did-change-build-status", {
      status: "success",
      file: filePath,
    });
  }

  /** @private */
  failBuild(filePath, error, output) {
    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] BuildService: failBuild(${filePath})`);
    }
    const endTime = Date.now();
    this.buildingFiles.set(filePath, { status: "error", endTime, error });
    this.emitter.emit("did-fail-build", {
      file: filePath,
      error: error,
      output: output,
    });
    this.emitter.emit("did-change-build-status", {
      status: "error",
      file: filePath,
      error: error,
    });
  }

  /** @private */
  updateMessages(filePath, messages) {
    this.emitter.emit("did-update-messages", {
      file: filePath,
      messages: messages,
    });
  }

  /** @private */
  emitCompileOnSaveChange(file, enabled, editor = null) {
    this.emitter.emit("did-change-compile-on-save", {
      editor: editor,
      file: file,
      enabled: enabled,
    });
  }

  /** @private */
  reset(filePath = null) {
    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] BuildService: reset(${filePath || "all"})`);
    }
    if (filePath) {
      this.buildingFiles.delete(filePath);
      this.emitter.emit("did-change-build-status", {
        status: "idle",
        file: filePath,
      });
    } else {
      this.buildingFiles.clear();
      this.emitter.emit("did-change-build-status", {
        status: "idle",
        file: null,
      });
    }
  }

  /** @private */
  destroy() {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] BuildService: destroy()");
    }
    this.buildingFiles.clear();
    this.emitter.dispose();
  }
};
