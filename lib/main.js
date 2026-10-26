const { CompositeDisposable, Disposable } = require("lumine");
const path = require("path");
const BuildService = require("./build-service");
const LinterProvider = require("./linter-provider");
let operationRuntime;
const getOperationRuntime = () =>
  (operationRuntime ||= require("./operations")({ path, normalizePathForTex }));

function isPending(item) {
  if (item.isPending != null) {
    return item.isPending();
  }
  const pane = lumine.workspace.getActivePane();
  return pane ? pane.getPendingItem() === item : false;
}

function normalizePathForTex(filePath) {
  const normalizedPath = path.normalize(filePath);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

/**
 * LaTeX Tools Package
 * Provides LaTeX compilation, PDF viewing, and error parsing.
 * Supports latexmk compilation, SyncTeX synchronization, compile-on-save,
 * and integration with linter and open-external packages.
 */
module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "latex-tools",
      tips: [
        "You can compile the LaTeX document you are editing with {{ 'latex-tools:compile' | keystroke }}",
      ],
    };
  },

  subscriptions: null,
  statusBarView: null,
  statusBarTile: null,
  observedFilesStatusView: null,
  observedFilesStatusTile: null,
  openExternalService: null,
  buildService: null,
  _logParser: null,
  get logParser() {
    if (!this._logParser) {
      const LogParser = require("./log-parser");
      this._logParser = new LogParser();
    }
    return this._logParser;
  },
  set logParser(parser) {
    this._logParser = parser;
  },
  linterProvider: null, // Linter provider for displaying issues
  observedFilesList: null,
  buildStates: null, // Track build state per file
  buildProcesses: null, // Track build processes per file for interruption
  pendingPdfOpens: null,
  compileOnSaveFiles: null, // Track file paths with compile-on-save enabled
  currentTexFile: null, // Current tex file shown in status bar (for PDF view support)
  activationGeneration: 0,
  activationInProgress: false,
  statusBarService: null,

  /**
   * Activates the package and registers LaTeX commands.
   * @param {Object} state - Serialized state from previous session
   */
  activate() {
    const generation = ++this.activationGeneration;
    this.activationInProgress = true;
    this.subscriptions = new CompositeDisposable();
    this.openExternalServices = new Map();
    this.openExternalService = null;
    this.buildService = new BuildService();
    this.buildService.setMainModule(this); // Set reference for API delegation
    this._logParser = null;
    this.linterProvider = new LinterProvider();
    // Constructing the observed-files SelectList walks the workspace view
    // graph and creates a modal host. It is not needed to register commands
    // or services, so create it on first use.
    this.observedFilesList = null;
    this._ensureObservedFilesList = () => {
      if (!this.observedFilesList) {
        const ObservedFilesList = require("./observed-list");
        this.observedFilesList = new ObservedFilesList(this);
      }
      return this.observedFilesList;
    };
    this.observedFilesStatusView = null;
    this.statusBarView = null;
    this.buildStates = new Map(); // Initialize build states tracking
    this.buildProcesses = new Map(); // Initialize build processes tracking
    this.commandRoots = new Map(); // Populated only while resolving a real TeX operation.
    this.pendingPdfOpens = new Map();
    this.compileOnSaveFiles = new Map(); // Initialize compile-on-save tracking

    // Register commands
    this.subscriptions.add(
      // These workspace operations deliberately resolve the current document
      // while another surface has focus. Editor shortcuts keep their grammar
      // scope, and handlers guard the saved LaTeX source they operate on.
      lumine.commands.add("lumine-workspace", {
        "latex-tools:compile": {
          description: "Build this document with latexmk and open the result.",
          isAvailable: (event) => this.isCommandAvailable(event, "compile"),
          didDispatch: (event) =>
            this.isStatusBarEvent(event) ? this.compileFromStatusBar(event) : this.compile(event),
        },
        "latex-tools:split-pdf-source": {
          description: "Open the PDF or its source in the adjacent pane.",
          isAvailable: (event) => this.isCommandAvailable(event, "status"),
          didDispatch: (event) => this.openPdfFromStatusBar(event),
        },
        "latex-tools:open-pdf": {
          description: "Open the built PDF in the editor's own viewer.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.openPdf(event),
        },
        "latex-tools:open-pdf-external": {
          description: "Open the built PDF in the system PDF viewer.",
          isAvailable: (event) =>
            Boolean(this.openExternalService && this.isCommandAvailable(event)),
          didDispatch: (event) => this.openPdfExternal(event),
        },
        "latex-tools:clean": {
          description: "Delete the auxiliary files latexmk generated.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.clean(event),
        },
        "latex-tools:clean-linter": {
          description: "Drop the messages the last build reported.",
          isAvailable: () => Boolean(this.linterProvider?.messageCount),
          didDispatch: () => this.cleanLinter(),
        },
        "latex-tools:interrupt": {
          description: "Stop the build of this document.",
          isAvailable: (event) => this.isCommandAvailable(event, "interrupt"),
          didDispatch: (event) => this.interrupt(event),
        },
        "latex-tools:interrupt-all": {
          description: "Stop every build now running.",
          isAvailable: () => this.buildProcesses.size > 0,
          didDispatch: () => this.interruptAll(),
        },
        "latex-tools:kill-and-clean": {
          description: "Stop the running build and delete its auxiliary files.",
          isAvailable: (event) => this.isCommandAvailable(event, "status"),
          didDispatch: (event) =>
            this.isStatusBarEvent(event)
              ? this.killAndCleanFromStatusBar(event)
              : this.killAndClean(event),
        },
        "latex-tools:toggle-compile-on-save": {
          description: "Build this document again whenever it is saved.",
          isAvailable: (event) => this.isCommandAvailable(event, "status"),
          didDispatch: (event) => this.toggleCompileOnSave(event),
        },
        "latex-tools:synctex": {
          description: "Jump the PDF view to the line the cursor is on.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.synctex(event),
        },
        "latex-tools:global-rc": {
          description: "Open the latexmkrc that applies to every project.",
          didDispatch: () => this.openLatexmkrc(),
        },
        "latex-tools:observed-files": {
          description: "List the files being built on save, and stop any of them.",
          didDispatch: () => this.showObservedFiles(),
        },
        "latex-tools:clear-all-observed-files": {
          description: "Stop building every file that was set to build on save.",
          isAvailable: () => this.compileOnSaveFiles.size > 0,
          didDispatch: () => this.clearCompileOnSaveFiles(),
        },
      }),
      // Track active pane item changes (text editors and PDF views)
      lumine.workspace.getCenter().observeActivePaneItem((item) => {
        this.updateStatusBarForItem(item);
      }),
      this.registerStatusBarMenu(),
    );

    require("./document-analysis").observe(this);

    // Service exchange and command registration are synchronous contracts;
    // status-bar/select-list DOM is not. Finish the UI bootstrap after the
    // activation batch so cold activation pays only for the lightweight state
    // and service facade. The generation guard also makes a queued task from a
    // deactivated package harmless during reloads.
    queueMicrotask(() => {
      if (this.activationGeneration !== generation || !this.subscriptions) return;
      this.activationInProgress = false;
      if (this.statusBarService && !this.statusBarTile) {
        this._attachStatusBar(this.statusBarService, generation);
      } else if (!this.statusBarService) {
        this.ensureStatusBarViews();
      }
      this.updateStatusBarForItem();
    });
  },

  /**
   * Deactivates the package and cleans up resources.
   */
  deactivate() {
    this.activationGeneration = (this.activationGeneration || 0) + 1;
    this.activationInProgress = false;
    this.statusBarService = null;
    this.clearPendingPdfOpens();
    // Kill all running build processes
    if (this.buildProcesses) {
      for (const processInfo of this.buildProcesses.values()) {
        this.killProcess(processInfo.process);
      }
      this.buildProcesses.clear();
      lumine.commands.invalidateAvailability();
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

    this.subscriptions?.dispose();
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
    this._ensureObservedFilesList = null;
  },

  ensureStatusBarViews() {
    if (!this.statusBarView) {
      const StatusBarView = require("./status-bar-view");
      this.statusBarView = new StatusBarView();
    }
    if (!this.observedFilesStatusView) {
      const ObservedFilesStatusView = require("./observed-status");
      this.observedFilesStatusView = new ObservedFilesStatusView();
    }
    return this.statusBarView;
  },

  _activeCenterItem() {
    return lumine.workspace.getCenter?.().getActivePaneItem?.() || null;
  },

  _attachStatusBar(statusBar, generation = this.activationGeneration) {
    if (generation !== this.activationGeneration) {
      return { statusBarTile: null, observedFilesStatusTile: null };
    }
    this.ensureStatusBarViews();
    // Language-tooling band on the left, observer band on the right. See the
    // priority convention in the status-bar package README.
    const statusBarTile = statusBar.addLeftTile({
      item: this.statusBarView.getElement(),
      priority: 420,
    });
    const observedFilesStatusTile = statusBar.addRightTile({
      item: this.observedFilesStatusView.getElement(),
      priority: 510,
    });
    this.statusBarTile = statusBarTile;
    this.observedFilesStatusTile = observedFilesStatusTile;
    this.updateObservedFilesStatus();

    this.updateStatusBarForItem();
    return { statusBarTile, observedFilesStatusTile };
  },

  consumeStatusBar(service) {
    return service.observeWindows((scopedStatusBar, context) =>
      this.consumeWindowStatusBar(scopedStatusBar, context),
    );
  },

  consumeWindowStatusBar(statusBar, _context) {
    this.statusBarService = statusBar;
    const registration = { statusBarTile: null, observedFilesStatusTile: null, disposed: false };
    const attach = () => {
      if (registration.disposed || this.activationGeneration === 0) return;
      const tiles = this._attachStatusBar(statusBar, this.activationGeneration);
      registration.statusBarTile = tiles.statusBarTile;
      registration.observedFilesStatusTile = tiles.observedFilesStatusTile;
    };
    // `consume()` is called during activateMain's synchronous service phase.
    // Deferring the first tile construction keeps StatusBarView/tooltips out
    // of the package activation measurement while preserving sync behavior for
    // later consumers and direct API callers.
    if (this.activationInProgress) queueMicrotask(attach);
    else attach();
    return new Disposable(() => {
      registration.disposed = true;
      registration.statusBarTile?.destroy();
      registration.observedFilesStatusTile?.destroy();
      if (this.statusBarTile === registration.statusBarTile) this.statusBarTile = null;
      if (this.observedFilesStatusTile === registration.observedFilesStatusTile) {
        this.observedFilesStatusTile = null;
      }
    });
  },

  commandEditor(event) {
    const editor = event?.context
      ? event.context.embeddedEditor
      : (lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false }) ??
        (event?.target
          ? lumine.workspace
              .getWindowForElement(event.target)
              ?.getEditorContainer()
              .getActiveEmbeddedTextEditor()
          : lumine.workspace.getActiveTextEditor()));
    return editor && !editor.isDestroyed() ? editor : null;
  },

  isCommandAvailable(event, kind) {
    const status = kind === "status" || (kind === "compile" && this.isStatusBarEvent(event));
    const filePath = status
      ? this.statusBarDocument(event).filePath
      : this.commandEditor(event)?.getPath();
    if (!filePath?.endsWith(".tex")) return false;
    const root = this.commandRoots.get(filePath) ?? filePath;
    const running = this.buildProcesses.has(root);
    if (kind === "interrupt") return running;
    return kind !== "compile" || !running;
  },

  isStatusBarEvent(event) {
    // A focus-targeted menu retains its status action through explicit detail.
    return (
      event?.detail?.fromStatusBar === true ||
      Boolean(event?.target?.closest?.(".latex-tools-status"))
    );
  },

  statusBarDocument(event) {
    const context =
      event?.context ?? (event?.target && lumine.workspace.resolveCommandContext(event));
    const editor = context ? context.embeddedEditor : lumine.workspace.getActiveTextEditor();
    const item = context ? context.documentItem : this._activeCenterItem();
    const pdf = Boolean(item?.filePath?.endsWith(".pdf"));
    const filePath = pdf
      ? item.filePath.replace(/\.pdf$/, ".tex")
      : (editor?.getPath() ?? (!context ? this.currentTexFile : null));
    return { context, editor: pdf ? null : editor, filePath, pdf };
  },

  registerStatusBarMenu() {
    const main = this;
    return lumine.contextMenu.add({
      "status-bar-tile.latex-tools-status": {
        commandTarget: "focus",
        items: require("../menus/main.json")["context-menu"][".latex-tools-status"].items.map(
          (item) => ({
            ...item,
            created: function (_event, { commandTarget }) {
              if (!item.command) return;
              const { filePath } = main.statusBarDocument({ target: commandTarget });
              this.enabled = Boolean(filePath?.endsWith(".tex"));
              if (item.command === "latex-tools:toggle-compile-on-save")
                this.checked = Boolean(
                  this.enabled && main.isCompileOnSaveEnabledForFile(filePath),
                );
            },
          }),
        ),
      },
    });
  },

  consumeOpenExternal(service) {
    const owner = this.subscriptions,
      edges = this.openExternalServices;
    if (!edges || owner.disposed) return new Disposable();
    const token = {};
    edges.set(token, service);
    this.openExternalService = service;
    lumine.commands.invalidateAvailability();
    const lease = new Disposable(() => {
      owner.remove(lease);
      edges.delete(token);
      if (this.openExternalServices === edges)
        this.openExternalService = [...edges.values()].at(-1) ?? null;
      lumine.commands.invalidateAvailability();
    });
    owner.add(lease);
    return lease;
  },

  provideLatexTools() {
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Providing latex-tools service");
    }
    return this.buildService;
  },

  consumeLinterRegistry(registerIndie) {
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Consuming linter.registry service");
    }
    const linter = registerIndie({
      name: "LaTeX",
    });
    this.linterProvider.register(linter);
    const registration = new Disposable(() => {
      linter.dispose();
      if (this.linterProvider.indieInstance === linter) this.linterProvider.register(null);
    });
    this.subscriptions.add(registration);
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Linter indie instance registered");
    }
    return registration;
  },

  hideStatusBar() {
    this.currentTexFile = null;
    this.statusBarView?.hide();
  },

  updateStatusBarForItem(item = this._activeCenterItem()) {
    if (item?.filePath?.endsWith(".pdf")) {
      this.updateStatusBarVisibility(item, "pdf");
    } else if (lumine.workspace.isTextEditor(item)) {
      this.updateStatusBarVisibility(item, "editor");
    } else {
      this.hideStatusBar();
    }
  },

  updateStatusBarVisibility(item, type) {
    // Show status bar for .tex files or adjacent PDF views
    if (!this.statusBarView) {
      return;
    }

    const fs = require("fs");
    let filePath = null;

    if (type === "editor") {
      if (item.getGrammar?.() === lumine.grammars.nullGrammar) {
        this.hideStatusBar();
        return;
      }
      filePath = item.getPath();
      if (!filePath || !filePath.endsWith(".tex")) {
        this.hideStatusBar();
        return;
      }
    } else if (type === "pdf") {
      const texFilePath = item.filePath.replace(/\.pdf$/, ".tex");
      if (!fs.existsSync(texFilePath)) {
        this.hideStatusBar();
        return;
      }
      filePath = texFilePath;
    }

    if (!filePath) {
      this.hideStatusBar();
      return;
    }

    if (!require("./document-analysis").allowsAutomaticBuild(filePath)) {
      this.hideStatusBar();
      return;
    }

    const rootPath = this.getRootFilePath(filePath) || filePath;

    // Track current root tex file for status bar actions
    this.currentTexFile = rootPath;

    // Get the build state for this file and update status bar
    const buildState = this.getBuildState(rootPath);
    if (lumine.config.get("latex-tools.debug")) {
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
    lumine.commands.invalidateAvailability();
    // Store build state for a specific file
    const existingState = this.buildStates.get(filePath) || {};
    this.buildStates.set(filePath, {
      status: status,
      message: message,
      timestamp: Date.now(),
      startTime: timerInfo.startTime || existingState.startTime || null,
      elapsedTime: timerInfo.elapsedTime || null,
    });
    if (lumine.config.get("latex-tools.debug")) {
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
  // Returns true if the file is either the active editor or shown via PDF view
  isStatusBarActiveFor(filePath) {
    const { rootForStatus } = require("./document-analysis");
    const rootPath = rootForStatus(this, filePath);
    const activeEditor = lumine.workspace.getActiveTextEditor();
    const activePath = activeEditor?.getPath();
    if (activePath && activePath.endsWith(".tex")) {
      const activeRootPath = rootForStatus(this, activePath);
      if (activeRootPath === rootPath) {
        return true;
      }
    } else if (activePath === rootPath) {
      return true;
    }
    // Also check if the current tex file matches (PDF view case)
    return this.currentTexFile === rootPath;
  },

  parseLogFile(filePath) {
    const fs = require("fs");
    const logPath = filePath.replace(/\.tex$/, ".log");

    if (!fs.existsSync(logPath)) {
      if (lumine.config.get("latex-tools.debug")) {
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
      if (lumine.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Parsed log file:`, stats);
      }
    } catch (error) {
      if (lumine.config.get("latex-tools.debug")) {
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
    const pendingOpens = this.pendingPdfOpens;
    const key = normalizePathForTex(path.resolve(filePath));
    const existing = pendingOpens.get(key);
    if (existing?.timeout === null) {
      existing.pdfPath = pdfPath;
      existing.openExternal = openExternal;
      return;
    }
    existing?.dispose();

    const disposable = new CompositeDisposable();
    const notification = lumine.notifications.addInfo("Waiting for compilation to finish...", {
      description: "The PDF will open automatically when the build completes.",
      dismissable: true,
    });
    const pending = {
      pdfPath,
      openExternal,
      timeout: null,
      dispose: () => {
        disposable.dispose();
        notification.dismiss();
        if (pending.timeout) clearTimeout(pending.timeout);
        pendingOpens.delete(key);
      },
    };
    pendingOpens.set(key, pending);

    const openPdfAfterBuild = () => {
      disposable.dispose();
      notification.dismiss();
      // Delay slightly to ensure file is fully written
      pending.timeout = setTimeout(() => {
        pending.dispose();
        if (pending.openExternal) {
          this._openPdfExternalDirect(pending.pdfPath);
        } else {
          this._openPdfDirect(pending.pdfPath);
        }
      }, 100);
    };

    disposable.add(
      this.buildService.onDidFinishBuild((data) => {
        if (normalizePathForTex(path.resolve(data.file)) === key) {
          openPdfAfterBuild();
        }
      }),
      this.buildService.onDidFailBuild((data) => {
        if (normalizePathForTex(path.resolve(data.file)) === key) {
          pending.dispose();
        }
      }),
    );
  },

  clearPendingPdfOpens() {
    for (const pending of this.pendingPdfOpens?.values() || []) {
      pending.dispose();
    }
  },

  _openPdfDirect(pdfPath, options = {}) {
    return lumine.workspace.open(pdfPath, { searchAllPanes: true, ...options }).catch((error) => {
      lumine.notifications.addError("Failed to open PDF", {
        detail: error.message,
        dismissable: true,
      });
    });
  },

  _openPdfExternalDirect(pdfPath) {
    if (!this.openExternalService) {
      lumine.notifications.addWarning("open-external service not available", {
        detail: "Please install the open-external package",
        dismissable: true,
      });
      return;
    }

    return this.openExternalService.openExternal(pdfPath).catch((error) => {
      lumine.notifications.addError("Failed to open PDF externally", {
        detail: error ? error.message || error : "Unknown error",
        dismissable: true,
      });
    });
  },

  openPdf(event) {
    const editor = this.commandEditor(event);
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
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
      lumine.notifications.addWarning("PDF file not found", {
        detail: `Expected file: ${pdfPath}\n\nPlease compile the LaTeX file first.`,
        dismissable: true,
      });
      return;
    }

    // Open the PDF file
    this._openPdfDirect(pdfPath);
  },

  openPdfExternal(event) {
    const editor = this.commandEditor(event);
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
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
      lumine.notifications.addWarning("PDF file not found", {
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
      if (lumine.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] Linter messages cleared");
      }
    }
  },

  openLatexmkrc() {
    const { getLatexmkrcPath, createLatexmkrc } = require("./utils");
    const latexmkrcPath = getLatexmkrcPath();
    const result = createLatexmkrc(latexmkrcPath);

    if (!result.success) {
      lumine.notifications.addError("Failed to create latexmkrc", {
        detail: result.error,
        dismissable: true,
      });
      return;
    }

    // Open the file in the editor
    lumine.workspace
      .open(latexmkrcPath)
      .then(() => {
        if (lumine.config.get("latex-tools.debug")) {
          console.log(`[LaTeX Tools] Opened latexmkrc: ${latexmkrcPath}`);
        }
      })
      .catch((error) => {
        lumine.notifications.addError("Failed to open latexmkrc", {
          detail: error.message,
          dismissable: true,
        });
      });
  },

  showObservedFiles() {
    return this._ensureObservedFilesList?.().show();
  },

  updateObservedFilesStatus() {
    lumine.commands.invalidateAvailability();
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

    return true;
  },

  clean(event) {
    const editor = this.commandEditor(event);
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
      return;
    }

    this.cleanFile(this.getRootFilePath(filePath) || filePath);
  },

  cleanFile(filePath) {
    return getOperationRuntime().cleanFile.call(this, filePath);
  },

  killProcess(childProcess) {
    if (!childProcess) return;

    // Kill the process tree (especially important on Windows)
    if (process.platform === "win32") {
      // On Windows, use taskkill to kill the entire process tree
      const { spawn } = require("child_process");
      const taskkill = spawn("taskkill", ["/pid", childProcess.pid.toString(), "/T", "/F"]);
      taskkill.on("exit", () => {
        if (lumine.config.get("latex-tools.debug")) {
          console.log(`[LaTeX Tools] Process tree killed for PID ${childProcess.pid}`);
        }
      });
    } else {
      // On Unix-like systems, kill the process group
      try {
        process.kill(-childProcess.pid, "SIGTERM");
      } catch (error) {
        if (lumine.config.get("latex-tools.debug")) {
          console.error("[LaTeX Tools] Failed to kill process group:", error);
        }
        childProcess.kill("SIGTERM");
      }
    }
  },

  interrupt(event) {
    const editor = this.commandEditor(event);
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
      return;
    }

    const knownRoot = this.commandRoots.get(filePath) ?? filePath;
    const rootPath = this.buildProcesses.has(knownRoot)
      ? knownRoot
      : require("./document-analysis").rootForStatus(this, filePath);
    const processInfo = this.buildProcesses.get(rootPath);
    if (!processInfo) {
      lumine.notifications.addInfo("No build process running for this file");
      return;
    }

    const fileName = path.basename(rootPath);

    // Kill the process
    this.killProcess(processInfo.process);

    // Remove from tracking
    this.buildProcesses.delete(rootPath);
    lumine.commands.invalidateAvailability();

    // Update status
    this.setBuildState(rootPath, "idle", "Build interrupted");
    this.statusBarView.setStatus("idle", "Build interrupted");

    // Notify build service
    if (this.buildService) {
      this.buildService.failBuild(rootPath, "Build interrupted by user", "");
    }

    // Clear linter messages
    this.cleanLinter();

    if (lumine.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
    }
  },

  interruptAll() {
    if (this.buildProcesses.size === 0) {
      lumine.notifications.addInfo("No build processes running");
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

      if (lumine.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
      }
    }

    // Clear all processes
    this.buildProcesses.clear();
    lumine.commands.invalidateAvailability();

    // Update status bar for current file
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor) {
      const filePath = editor.getPath();
      if (filePath && filePath.endsWith(".tex")) {
        this.statusBarView.setStatus("idle", "Build interrupted");
      }
    }

    // Clear linter messages
    this.cleanLinter();

    lumine.notifications.addWarning(`Interrupted ${count} build process(es)`, {
      detail: fileNames.join("\n"),
    });
  },

  killAndClean(event) {
    const editor = this.commandEditor(event);
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
      return;
    }

    // First, interrupt any running build for this file
    const knownRoot = this.commandRoots.get(filePath) ?? filePath;
    const rootPath = this.buildProcesses.has(knownRoot)
      ? knownRoot
      : this.getRootFilePath(filePath) || filePath;
    const processInfo = this.buildProcesses.get(rootPath);
    if (processInfo) {
      const fileName = path.basename(rootPath);

      // Kill the process
      this.killProcess(processInfo.process);

      // Remove from tracking
      this.buildProcesses.delete(rootPath);
      lumine.commands.invalidateAvailability();

      // Update status
      this.setBuildState(rootPath, "idle", "Build interrupted");
      this.statusBarView.setStatus("idle", "Build interrupted");

      // Notify build service
      if (this.buildService) {
        this.buildService.failBuild(rootPath, "Build interrupted by user", "");
      }

      if (lumine.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Build process interrupted for ${fileName}`);
      }

      lumine.notifications.addInfo(`Build interrupted for ${fileName}`);
    }

    // Then run the clean command
    this.clean(event);
  },

  toggleCompileOnSave(event) {
    const { editor, filePath } = this.statusBarDocument(event);
    if (!editor && !filePath) return;
    if (editor && isPending(editor)) {
      const pane = lumine.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }
    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
      return;
    }

    const fileName = path.basename(filePath);
    const enabled = this.isCompileOnSaveEnabledForFile(filePath);

    if (enabled) {
      const changed = this.setCompileOnSaveForFile(filePath, false, editor);
      if (!changed) {
        return;
      }
      lumine.notifications.addHint(`Compile on save disabled for ${fileName}`);

      if (lumine.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Compile on save disabled for ${fileName}`);
      }
    } else {
      const changed = this.setCompileOnSaveForFile(filePath, true, editor);
      if (!changed) {
        lumine.notifications.addWarning("Failed to enable compile on save", {
          detail: `Could not observe ${filePath}`,
          dismissable: true,
        });
        return;
      }
      lumine.notifications.addHint(`Compile on save enabled for ${fileName}`);

      if (lumine.config.get("latex-tools.debug")) {
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
    const editor = lumine.workspace.getTextEditors().find((item) => item.id === editorId);
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
      if (lumine.config.get("latex-tools.debug")) {
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

  // Status bar click handlers - work with both text editors and PDF views
  async compileFromStatusBar(event) {
    const { editor, filePath, context } = this.statusBarDocument(event);
    if (!filePath?.endsWith(".tex")) return;
    if (editor) return this.compile(event);
    const generation = this.activationGeneration;
    const subscriptions = this.subscriptions;
    const current = () =>
      this.activationGeneration === generation &&
      this.subscriptions === subscriptions &&
      !subscriptions.disposed &&
      !context?.documentItem?.isDestroyed?.();
    const editors = lumine.workspace.getTextEditors();
    const sourceEditor = editors.find((candidate) => candidate.getPath() === filePath);
    if (sourceEditor && sourceEditor.getFileState() !== "unmodified") await sourceEditor.save();
    if (
      !current() ||
      sourceEditor?.isDestroyed() ||
      (sourceEditor && sourceEditor.getPath() !== filePath)
    )
      return;
    const rootPath = this.getRootFilePath(filePath) || filePath;
    if (this.checkBuildStatus(rootPath)) {
      lumine.notifications.addWarning("Build already in progress", {
        detail: `${path.basename(rootPath)} is currently being compiled.`,
        dismissable: true,
      });
      return;
    }
    const rootEditor = editors.find((candidate) => candidate.getPath() === rootPath);
    if (rootEditor && rootEditor !== sourceEditor && rootEditor.getFileState() !== "unmodified")
      await rootEditor.save();
    if (
      !current() ||
      rootEditor?.isDestroyed() ||
      (rootEditor && rootEditor.getPath() !== rootPath) ||
      this.buildProcesses.has(rootPath)
    )
      return;
    this.runCompilation(rootPath);
  },

  openPdfFromStatusBar(event) {
    const { context, filePath, pdf } = this.statusBarDocument(event);
    if (!filePath?.endsWith(".tex")) return;
    const fs = require("fs");
    const target = pdf ? filePath : this.getPdfPathForFile(filePath);
    if (!fs.existsSync(target)) {
      lumine.notifications.addWarning(pdf ? "TeX file not found" : "PDF file not found", {
        detail: `Expected file: ${target}`,
        dismissable: true,
      });
      return;
    }
    const options = { split: pdf ? "left" : "right" };
    if (context?.documentPane) options.pane = context.documentPane;
    if (pdf) return lumine.workspace.open(target, { ...options, searchAllPanes: true });
    return this._openPdfDirect(target, options);
  },

  killAndCleanFromStatusBar(event) {
    const { editor, filePath } = this.statusBarDocument(event);
    if (!filePath?.endsWith(".tex")) return;
    if (editor) return this.killAndClean(event);
    const knownRoot = this.commandRoots.get(filePath) ?? filePath;
    const rootPath = this.buildProcesses.has(knownRoot)
      ? knownRoot
      : this.getRootFilePath(filePath) || filePath;
    const processInfo = this.buildProcesses.get(rootPath);
    if (processInfo) {
      const fileName = path.basename(rootPath);
      this.killProcess(processInfo.process);
      this.buildProcesses.delete(rootPath);
      lumine.commands.invalidateAvailability();
      this.setBuildState(rootPath, "idle", "Build interrupted");
      this.statusBarView?.setStatus("idle", "Build interrupted");
      this.buildService?.failBuild(rootPath, "Build interrupted by user", "");
      lumine.notifications.addInfo(`Build interrupted for ${fileName}`);
    }
    return this.cleanFile(rootPath);
  },

  async compile(event) {
    const editor = this.commandEditor(event);
    // No editor at all is already on screen; a notification per command is noise.
    if (!editor) return;
    const generation = this.activationGeneration;
    const subscriptions = this.subscriptions;
    const buffer = editor.getBuffer();
    const current = () =>
      this.activationGeneration === generation &&
      this.subscriptions === subscriptions &&
      !subscriptions.disposed &&
      !editor.isDestroyed() &&
      editor.getBuffer() === buffer &&
      editor.getPath() === filePath;

    if (isPending(editor)) {
      const pane = lumine.workspace.paneForItem(editor);
      if (pane) pane.clearPendingItem();
    }

    const filePath = editor.getPath();
    if (!filePath) {
      lumine.notifications.addWarning("File not saved");
      return;
    }

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
      return;
    }

    if (editor.getFileState() !== "unmodified") await editor.save();
    if (!current()) return;

    const rootPath = this.getRootFilePath(filePath) || filePath;

    // Check if already building this file
    if (this.checkBuildStatus(rootPath)) {
      lumine.notifications.addWarning("Build already in progress", {
        detail: `${path.basename(rootPath)} is currently being compiled.`,
        dismissable: true,
      });
      return;
    }

    const rootEditor = lumine.workspace.getTextEditors().find((e) => e.getPath() === rootPath);
    if (rootEditor && rootEditor !== editor && rootEditor.getFileState() !== "unmodified") {
      await rootEditor.save();
    }
    if (
      !current() ||
      rootEditor?.isDestroyed() ||
      (rootEditor && rootEditor.getPath() !== rootPath) ||
      this.buildProcesses.has(rootPath)
    )
      return;

    // Run the compilation
    this.runCompilation(rootPath);
  },

  runCompilation(filePath) {
    return getOperationRuntime().runCompilation.call(this, filePath);
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

    const knownRoot = this.commandRoots.get(filePath) ?? filePath;
    const rootPath = this.buildProcesses.has(knownRoot)
      ? knownRoot
      : this.getRootFilePath(filePath) || filePath;
    const processInfo = this.buildProcesses.get(rootPath);
    if (!processInfo) {
      return false;
    }

    const fileName = path.basename(rootPath);

    // Kill the process
    this.killProcess(processInfo.process);

    // Remove from tracking
    this.buildProcesses.delete(rootPath);
    lumine.commands.invalidateAvailability();

    // Update status
    this.setBuildState(rootPath, "idle", "Build interrupted");

    // Update status bar if this file is active (editor or PDF view)
    if (this.isStatusBarActiveFor(rootPath)) {
      this.statusBarView.setStatus("idle", "Build interrupted");
    }

    // Notify build service
    if (this.buildService) {
      this.buildService.failBuild(rootPath, "Build interrupted by user", "");
    }

    if (lumine.config.get("latex-tools.debug")) {
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

    lumine.commands.invalidateAvailability();

    // Update status bar for current file
    const editor = lumine.workspace.getActiveTextEditor();
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
      const editor = lumine.workspace.getActiveTextEditor();
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
      if (lumine.config.get("latex-tools.debug")) {
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
      await lumine.workspace.open(pdfPath, { searchAllPanes: true });
      return true;
    } catch (error) {
      if (lumine.config.get("latex-tools.debug")) {
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
      if (lumine.config.get("latex-tools.debug")) {
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
      if (this.compileOnSaveFiles?.get(key) !== info) return;
      if (info.timeout) {
        clearTimeout(info.timeout);
        info.timeout = null;
      }

      if (!require("./document-analysis").allowsAutomaticBuild(resolvedFilePath)) return;
      info.timeout = setTimeout(() => {
        info.timeout = null;
        if (
          this.compileOnSaveFiles?.get(key) === info &&
          require("./document-analysis").allowsAutomaticBuild(resolvedFilePath)
        )
          this.compileFilePath(filePath);
      }, 150);
    };

    try {
      const { watchFile } = require("lumine");
      info.file = watchFile(resolvedFilePath);
      info.disposable = new CompositeDisposable(
        info.file,
        info.file.onDidChange(scheduleCompile),
        info.file.onDidInvalidate(scheduleCompile),
        info.file.onDidError((error) => console.error("Unable to watch TeX source", error)),
      );
    } catch (error) {
      if (lumine.config.get("latex-tools.debug")) {
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
    return lumine.workspace.getTextEditors().filter((editor) => {
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
    const root = this.resolveTexRoot(filePath);
    if (root && this.commandRoots) this.commandRoots.set(filePath, root);
    return root;
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
    if (!filePath || !filePath.endsWith(".tex")) return null;
    return getOperationRuntime().resolveTexRoot.call(this, filePath);
  },

  /**
   * Find likely root documents that include a source file.
   * @param {string} filePath - Path to a .tex file
   * @returns {Array<string>} Candidate root .tex paths
   */
  findRootCandidatesForFile(filePath) {
    return getOperationRuntime().findRootCandidatesForFile.call(this, filePath);
  },

  /**
   * Forward SyncTeX: source to PDF (API method)
   * @param {string} texPath - Path to the .tex file
   * @param {number} line - Line number (1-based)
   * @param {number} column - Column number (0-based)
   * @returns {Promise<Object|null>} PDF location or null
   */
  async syncToPdf(texPath, line, column = 0) {
    return getOperationRuntime().syncToPdf.call(this, texPath, line, column);
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
    return getOperationRuntime().syncToSource.call(this, pdfPath, page, x, y);
  },

  /**
   * Forward SyncTeX command: jumps from editor cursor to PDF position.
   * Uses syncToPdf() utility, then opens/scrolls the PDF view.
   */
  async synctex(event) {
    const editor = this.commandEditor(event);
    if (!editor) return;

    const file = editor.getPath();
    if (!file || !file.endsWith(".tex")) return;

    const position = editor.getLastCursor().getBufferPosition();
    const result = await this.syncToPdf(file, position.row + 1, position.column + 1);
    if (!result) return;

    const pdfFile = result.pdfPath || file.replace(/\.tex$/, ".pdf");

    // open() returns existing viewer or creates new one
    const viewer = await lumine.workspace.open(`${pdfFile}`, {
      split: "right",
      searchAllPanes: true,
    });

    // An open can decline, e.g. when the workspace center is full.
    if (!viewer) return;

    // Wait for viewer to be ready if it was just created
    if (viewer.whenReady) {
      await viewer.whenReady();
    }

    // Scroll to precise position if viewer supports it
    if (viewer.scrollToPosition) {
      viewer.scrollToPosition(result.page - 1, result.x, result.y);
    }

    lumine.views.getView(editor).focus();
  },
};
