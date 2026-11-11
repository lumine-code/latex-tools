const { CompositeDisposable, Disposable, Emitter } = require("lumine");
const path = require("path");
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
  openExternalService: null,
  buildService: null,
  observedFilesList: null,
  pendingPdfOpens: null,
  activationGeneration: 0,

  /**
   * Activates the package and registers LaTeX commands.
   * @param {Object} state - Serialized state from previous session
   */
  activate() {
    ++this.activationGeneration;
    this.subscriptions = new CompositeDisposable();
    this.pdfBuildEvents = new Emitter();
    this.subscriptions.add(this.pdfBuildEvents);
    this.openExternalServices = new Map();
    this.openExternalService = null;
    this.buildEdges = new Map();
    this.buildService = null;
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
    this.watchPathCache = new Map();
    this.commandRoots = new Map(); // Populated only while resolving a real TeX operation.
    this.pendingPdfOpens = new Map();

    // Register commands
    this.subscriptions.add(
      // These workspace operations deliberately resolve the current document
      // while another surface has focus. Editor shortcuts keep their grammar
      // scope, and handlers guard the saved LaTeX source they operate on.
      lumine.commands.add("lumine-workspace", {
        "latex-tools:compile": {
          description: "Build this document with latexmk and open the result.",
          isAvailable: (event) => this.isCommandAvailable(event, "compile"),
          didDispatch: (event) => this.compile(event),
        },
        "latex-tools:split-pdf-source": {
          description: "Open the PDF or its source in the adjacent pane.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.openDocumentPair(event),
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
          isAvailable: () => this.getLogMessages().length > 0,
          didDispatch: () => this.cleanLinter(),
        },
        "latex-tools:interrupt": {
          description: "Stop the build of this document.",
          isAvailable: (event) => this.isCommandAvailable(event, "interrupt"),
          didDispatch: (event) => this.interrupt(event),
        },
        "latex-tools:interrupt-all": {
          description: "Stop every build now running.",
          isAvailable: () => this.getActiveBuilds().length > 0,
          didDispatch: () => this.interruptAll(),
        },
        "latex-tools:kill-and-clean": {
          description: "Stop the running build and delete its auxiliary files.",
          isAvailable: (event) => this.isCommandAvailable(event),
          didDispatch: (event) => this.killAndClean(event),
        },
        "latex-tools:toggle-compile-on-save": {
          description: "Build this document again whenever it is saved.",
          checked: (event) => {
            const { filePath } = this.commandDocument(event);
            return Boolean(filePath && this.isCompileOnSaveEnabledForFile(filePath));
          },
          isAvailable: (event) => Boolean(this.buildService && this.isCommandAvailable(event)),
          didDispatch: (event) => this.toggleCompileOnSave(event),
        },
        "latex-tools:synctex": {
          description: "Jump the PDF view to the line the cursor is on.",
          isAvailable: (event) => Boolean(this.commandEditor(event)?.getPath()?.endsWith(".tex")),
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
          isAvailable: () => this.getCompileOnSaveFiles().length > 0,
          didDispatch: () => this.clearCompileOnSaveFiles(),
        },
      }),
    );
  },

  /**
   * Deactivates the package and cleans up resources.
   */
  deactivate() {
    this.activationGeneration = (this.activationGeneration || 0) + 1;
    this.clearPendingPdfOpens();
    this.subscriptions?.dispose();
    this.buildService = null;
    this.buildEdges?.clear();
    this.watchPathCache?.clear();
    this.observedFilesList?.destroy();
    this.observedFilesList = null;
    this._ensureObservedFilesList = null;
  },

  _activeCenterItem() {
    return lumine.workspace.getCenter?.().getActivePaneItem?.() || null;
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
    const filePath = this.commandDocument(event).filePath;
    if (!filePath?.endsWith(".tex") || (kind === "compile" && !this.buildService)) return false;
    const root = this.commandRoots.get(filePath) ?? filePath;
    const running = this.checkBuildStatus(root);
    if (kind === "interrupt") return running;
    return kind !== "compile" || !running;
  },

  commandDocument(event) {
    const context =
      event?.context ?? (event?.target && lumine.workspace.resolveCommandContext(event));
    const editor = context ? context.embeddedEditor : this.commandEditor(event);
    const item = context ? context.documentItem : this._activeCenterItem();
    const itemPath = item?.getPath?.() ?? item?.filePath;
    const pdf = Boolean(itemPath?.endsWith(".pdf"));
    const filePath = pdf ? itemPath.replace(/\.pdf$/, ".tex") : editor?.getPath();
    return { context, editor: pdf ? null : editor, filePath, pdf };
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

  provideSynctex() {
    const owner = this.subscriptions;
    return {
      syncToPdf: (...args) =>
        owner && !owner.disposed ? this.syncToPdf(...args) : Promise.resolve(null),
      syncToSource: (...args) =>
        owner && !owner.disposed ? this.syncToSource(...args) : Promise.resolve(null),
    };
  },

  providePdfBuildProvider() {
    const owner = this.subscriptions;
    const events = this.pdfBuildEvents;
    const current = () => owner && !owner.disposed && this.subscriptions === owner;
    const sourceValid = (filePath) =>
      typeof filePath === "string" &&
      path.isAbsolute(filePath) &&
      !filePath.includes("\0") &&
      filePath.endsWith(".tex");
    const canBuild = (filePath) =>
      Boolean(
        current() &&
        this.buildService &&
        sourceValid(filePath) &&
        !this.isJobActive(this.buildService.getJob({ providerId: "latex-tools", filePath })),
      );
    const canToggleCompileOnSave = (sourcePath) =>
      Boolean(current() && this.buildService && sourceValid(sourcePath));
    const isCompileOnSaveEnabled = (sourcePath) =>
      canToggleCompileOnSave(sourcePath) && this.isCompileOnSaveEnabledForFile(sourcePath);
    return {
      id: "latex-tools",
      name: "LaTeX",
      resolveSource: async (pdfPath, { signal, sourcePath } = {}) => {
        if (!current()) return null;
        signal?.throwIfAborted();
        if (
          typeof pdfPath !== "string" ||
          !path.isAbsolute(pdfPath) ||
          pdfPath.includes("\0") ||
          !/\.pdf$/i.test(pdfPath)
        )
          return null;
        const backend = this.buildService;
        const association = backend?.getArtifactTarget(pdfPath) ?? null;
        const valid = () => {
          if (!current() || this.buildService !== backend) return false;
          const latest = backend?.getArtifactTarget(pdfPath) ?? null;
          return (
            latest?.providerId === association?.providerId &&
            latest?.filePath === association?.filePath
          );
        };
        const existingRoot = async (candidate) => {
          if (!sourceValid(candidate) || !valid()) return null;
          signal?.throwIfAborted();
          try {
            if (!(await require("node:fs/promises").stat(candidate)).isFile()) return null;
          } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
            signal?.throwIfAborted();
            return null;
          }
          signal?.throwIfAborted();
          if (!valid()) return null;
          const root = this.getRootFilePath(candidate) || candidate;
          if (normalizePathForTex(root) !== normalizePathForTex(candidate)) {
            try {
              if (!(await require("node:fs/promises").stat(root)).isFile()) return null;
            } catch (error) {
              if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
              signal?.throwIfAborted();
              return null;
            }
          }
          signal?.throwIfAborted();
          return valid() && sourceValid(root) ? root : null;
        };
        if (association) {
          if (association.providerId !== "latex-tools") return null;
          return existingRoot(association.filePath);
        }
        for (const candidate of [sourcePath, pdfPath.replace(/\.pdf$/i, ".tex")]) {
          const root = await existingRoot(candidate);
          signal?.throwIfAborted();
          if (!valid()) return null;
          if (
            root &&
            normalizePathForTex(root.replace(/\.tex$/, ".pdf")) === normalizePathForTex(pdfPath)
          )
            return root;
        }
        return null;
      },
      canBuild,
      build: (sourcePath) => (canBuild(sourcePath) ? this.runCompilation(sourcePath) : null),
      canToggleCompileOnSave,
      isCompileOnSaveEnabled,
      toggleCompileOnSave: (sourcePath) =>
        canToggleCompileOnSave(sourcePath)
          ? this.setCompileOnSaveForFile(sourcePath, !isCompileOnSaveEnabled(sourcePath))
          : false,
      isBuilding: (pdfPath) =>
        Boolean(
          current() &&
          typeof pdfPath === "string" &&
          this.buildService
            ?.getJobs({ providerId: "latex-tools", activeOnly: true })
            .some((job) =>
              job.artifacts.some(
                (artifact) =>
                  artifact.kind === "pdf" &&
                  normalizePathForTex(artifact.path) === normalizePathForTex(pdfPath),
              ),
            ),
        ),
      onDidChangeBuilds: (callback) =>
        current() ? events.on("builds", callback) : new Disposable(),
      onDidChangeSources: (callback) =>
        current() ? events.on("sources", callback) : new Disposable(),
    };
  },

  consumeTasks(service) {
    const owner = this.subscriptions;
    const events = this.pdfBuildEvents;
    const edges = this.buildEdges;
    if (!owner || owner.disposed || !edges) return new Disposable();
    let record = edges.get(service);
    if (!record) {
      record = { refs: 0, subscriptions: new CompositeDisposable() };
      edges.set(service, record);
      const provider = {
        id: "latex-tools",
        name: "LaTeX",
        supports: (filePath) => typeof filePath === "string" && filePath.endsWith(".tex"),
        resolve: (filePath) => this.getRootFilePath(filePath) || filePath,
        prepare: async ({ filePath, reason }, signal) => {
          signal.throwIfAborted();
          if (reason === "manual") {
            const editor = lumine.workspace
              .getTextEditors()
              .find((item) => item.getPath() === filePath);
            if (editor && editor.getFileState() !== "unmodified") await editor.save();
            signal.throwIfAborted();
          }
          const { commandFor, snapshotDiagnostics } = require("./latex-target");
          return {
            ...commandFor(filePath),
            diagnosticSnapshot: snapshotDiagnostics(filePath, this.getWatchPaths(filePath)),
            artifacts: [
              { path: filePath.replace(/\.tex$/, ".pdf"), kind: "pdf", sourcePath: filePath },
            ],
          };
        },
        collectResult: (result, signal) => this.collectBuildResult(result, signal),
        getWatchPaths: (filePath) => this.getWatchPaths(filePath),
      };
      try {
        record.subscriptions.add(service.registerProvider(provider));
        const current = () =>
          this.subscriptions === owner &&
          !owner.disposed &&
          edges.get(service) === record &&
          this.buildService === service;
        const update = (job) => {
          if (job.providerId !== "latex-tools" || !current()) return;
          lumine.commands.invalidateAvailability();
          events.emit("builds");
        };
        record.subscriptions.add(
          service.onDidChangeJob(update),
          service.onDidChangeArtifactTargets(({ artifactPath }) => {
            if (!current()) return;
            events.emit("sources", { pdfPath: artifactPath });
          }),
          service.onDidChangeObserved(({ providerId }) => {
            if (providerId !== "latex-tools" || !current()) return;
            this.refreshObservedFiles();
            events.emit("builds");
          }),
        );
      } catch (error) {
        edges.delete(service);
        record.subscriptions.dispose();
        throw error;
      }
    }
    record.refs++;
    this.buildService = service;
    const lease = new Disposable(() => {
      owner.remove(lease);
      if (--record.refs === 0) {
        edges.delete(service);
        record.subscriptions.dispose();
      }
      if (this.buildEdges !== edges || owner.disposed) return;
      this.buildService = [...edges.keys()].at(-1) ?? null;
      this.refreshObservedFiles();
      events.emit("sources", {});
      events.emit("builds");
    });
    owner.add(lease);
    this.refreshObservedFiles();
    events.emit("sources", {});
    events.emit("builds");
    return lease;
  },

  collectBuildResult(result, signal) {
    signal.throwIfAborted();
    const { filePath } = result;
    const diagnostics = require("./latex-target").diagnosticsFor(filePath, result);
    // A successful cleanup can remove the recorder. Keep its source metadata
    // for the build service's subsequent watcher refresh.
    const dependencies = getOperationRuntime().getWatchPaths.call(this, filePath);
    signal.throwIfAborted();
    const source = require("./latex-target").sourceFingerprint(filePath);
    const key = normalizePathForTex(filePath);
    if (source && source === result.plan?.diagnosticSnapshot?.sourceFingerprint)
      this.watchPathCache.set(key, { source, dependencies });
    else this.watchPathCache.delete(key);
    if (
      result.code === 0 &&
      !result.error &&
      !result.signal &&
      lumine.config.get("latex-tools.cleanAuxFiles")
    ) {
      try {
        const { failedFiles } = require("./auxiliary-files").cleanAuxiliaries(
          filePath,
          lumine.config.get("latex-tools.cleanExtensions") || [],
        );
        if (failedFiles.length)
          diagnostics.push(
            this.cleanupDiagnostic(
              filePath,
              `Failed to remove auxiliary files: ${failedFiles.join(", ")}`,
            ),
          );
        for (const diagnostic of diagnostics) {
          if (diagnostic.reference && !require("node:fs").existsSync(diagnostic.reference.file))
            delete diagnostic.reference;
        }
      } catch (error) {
        diagnostics.push(
          this.cleanupDiagnostic(filePath, `Failed to clean auxiliary files: ${error.message}`),
        );
      }
    }
    return {
      diagnostics,
      artifacts: result.plan?.artifacts ?? [
        { path: filePath.replace(/\.tex$/, ".pdf"), kind: "pdf", sourcePath: filePath },
      ],
    };
  },

  cleanupDiagnostic(filePath, excerpt) {
    return {
      severity: "warning",
      excerpt,
      location: {
        file: filePath,
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
  },

  getWatchPaths(filePath) {
    const fresh = getOperationRuntime().getWatchPaths.call(this, filePath);
    if (require("node:fs").existsSync(filePath.replace(/\.tex$/, ".fls"))) return fresh;
    const key = normalizePathForTex(filePath);
    const cached = this.watchPathCache.get(key);
    if (!cached) return fresh;
    if (cached.source !== require("./latex-target").sourceFingerprint(filePath)) {
      this.watchPathCache.delete(key);
      return fresh;
    }
    return [...new Set([...fresh, ...cached.dependencies])];
  },

  isJobActive(job) {
    return Boolean(job && ["preparing", "running", "collecting"].includes(job.state));
  },

  getActiveBuilds() {
    return this.buildService?.getJobs({ providerId: "latex-tools", activeOnly: true }) ?? [];
  },

  getBuildState(filePath) {
    const job = this.buildService?.getJob({ providerId: "latex-tools", filePath });
    const status = !job
      ? "idle"
      : this.isJobActive(job)
        ? "building"
        : job.state === "passed"
          ? "success"
          : job.state === "failed"
            ? "error"
            : "idle";
    return {
      status,
      message: job ? `${path.basename(filePath)}: ${job.state}` : "LaTeX",
      startTime: job?.startedAt ?? null,
      elapsedTime: job?.elapsedTime ?? null,
    };
  },

  checkBuildStatus(filePath) {
    const rootPath = this.commandRoots.get(filePath) ?? filePath;
    return this.isJobActive(
      this.buildService?.getJob({ providerId: "latex-tools", filePath: rootPath }),
    );
  },

  waitForBuildAndOpen(filePath, pdfPath, openExternal = false) {
    const service = this.buildService;
    if (!service) return;
    const pendingOpens = this.pendingPdfOpens;
    const key = normalizePathForTex(path.resolve(filePath));
    const existing = pendingOpens.get(key);
    if (existing?.timeout === null) {
      existing.pdfPath = pdfPath;
      existing.openExternal = openExternal;
      return;
    }
    existing?.dispose();
    const notification = lumine.notifications.addInfo("Waiting for compilation to finish...", {
      description: "The PDF will open automatically when the build completes.",
      dismissable: true,
    });
    const owner = this.subscriptions;
    const pending = {
      pdfPath,
      openExternal,
      timeout: null,
      dispose: () => {
        subscription.dispose();
        notification.dismiss();
        if (pending.timeout) clearTimeout(pending.timeout);
        if (pendingOpens.get(key) === pending) pendingOpens.delete(key);
      },
    };
    const subscription = service.onDidFinishJob((job) => {
      if (
        job.providerId !== "latex-tools" ||
        normalizePathForTex(path.resolve(job.filePath)) !== key
      )
        return;
      if (job.state !== "passed") {
        pending.dispose();
        return;
      }
      subscription.dispose();
      notification.dismiss();
      pending.timeout = setTimeout(() => {
        pending.dispose();
        if (owner.disposed || this.subscriptions !== owner) return;
        if (pending.openExternal) this._openPdfExternalDirect(pending.pdfPath);
        else this._openPdfDirect(pending.pdfPath, {}, job.filePath);
      }, 100);
    });
    pendingOpens.set(key, pending);
  },

  clearPendingPdfOpens() {
    for (const pending of this.pendingPdfOpens?.values() || []) {
      pending.dispose();
    }
  },

  _openPdfDirect(pdfPath, options = {}, filePath) {
    if (filePath)
      this.buildService?.associateArtifact({ providerId: "latex-tools", filePath }, pdfPath);
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
    const { filePath } = this.commandDocument(event);
    if (!filePath) return;

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
    this._openPdfDirect(pdfPath, {}, rootPath);
  },

  openPdfExternal(event) {
    const { filePath } = this.commandDocument(event);
    if (!filePath) return;

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
    this.buildService?.clearMessages({ providerId: "latex-tools" });
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

  refreshObservedFiles() {
    lumine.commands.invalidateAvailability();
    this.observedFilesList?.update();
  },

  clearCompileOnSaveFiles() {
    if (!this.getCompileOnSaveFiles().length) return false;
    this.buildService?.clearObserved({ providerId: "latex-tools" });
    return true;
  },

  clean(event) {
    const { filePath } = this.commandDocument(event);
    if (!filePath) return;

    if (!filePath.endsWith(".tex")) {
      lumine.notifications.addWarning("Not a LaTeX file");
      return;
    }

    this.cleanFile(this.getRootFilePath(filePath) || filePath);
  },

  cleanFile(filePath) {
    return getOperationRuntime().cleanFile.call(this, filePath);
  },

  interrupt(event) {
    const { filePath } = this.commandDocument(event);
    return filePath?.endsWith(".tex") ? this.interruptFile(filePath) : false;
  },

  interruptAll() {
    return this.buildService?.stopAll({ providerId: "latex-tools" }) ?? 0;
  },

  toggleCompileOnSave(event) {
    const { editor, filePath } = this.commandDocument(event);
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
      if (lumine.config.get("latex-tools.debug")) {
        console.log(`[LaTeX Tools] Compile on save enabled for ${fileName}`);
      }
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

  // Commands retain their source/PDF document across asynchronous operations.

  async compile(event) {
    const { editor, filePath, context } = this.commandDocument(event);
    if (!filePath?.endsWith(".tex")) return;
    if (editor) return this.compileEditor(event);
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
      this.checkBuildStatus(rootPath)
    )
      return;
    this.runCompilation(rootPath);
  },

  openDocumentPair(event) {
    const { context, filePath, pdf } = this.commandDocument(event);
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
    return this._openPdfDirect(target, options, this.getRootFilePath(filePath) || filePath);
  },

  async killAndClean(event) {
    const owner = this.subscriptions;
    const { filePath } = this.commandDocument(event);
    if (!filePath?.endsWith(".tex")) return;
    const rootPath = this.getRootFilePath(filePath) || filePath;
    const job = this.buildService?.getJob({ providerId: "latex-tools", filePath: rootPath });
    if (this.isJobActive(job)) {
      job.stop();
      await job.completion;
    }
    if (owner && !owner.disposed && this.subscriptions === owner) return this.cleanFile(rootPath);
  },

  async compileEditor(event) {
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
      this.checkBuildStatus(rootPath)
    )
      return;

    // Run the compilation
    this.runCompilation(rootPath);
  },

  runCompilation(filePath) {
    if (!this.subscriptions || this.subscriptions.disposed) return null;
    return (
      this.buildService?.run({ providerId: "latex-tools", filePath, reason: "manual" }) ?? null
    );
  },

  interruptFile(filePath) {
    const rootPath = this.commandRoots.get(filePath) ?? filePath;
    return this.buildService?.stop({ providerId: "latex-tools", filePath: rootPath }) ?? false;
  },

  getLogMessages(filePath = null) {
    return (
      this.buildService?.getMessages({
        providerId: "latex-tools",
        ...(filePath ? { filePath } : {}),
      }) ?? []
    );
  },

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
      this.buildService?.associateArtifact(
        { providerId: "latex-tools", filePath: this.getRootFilePath(filePath) || filePath },
        pdfPath,
      );
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

  isCompileOnSaveEnabledForFile(filePath) {
    if (!filePath?.endsWith(".tex")) return false;
    const key = normalizePathForTex(path.resolve(this.commandRoots.get(filePath) ?? filePath));
    return this.getCompileOnSaveFiles().some(
      (observed) => normalizePathForTex(path.resolve(observed)) === key,
    );
  },

  setCompileOnSaveForFile(filePath, enabled) {
    if (!filePath?.endsWith(".tex")) return false;
    return (
      this.buildService?.setObserved({ providerId: "latex-tools", filePath }, enabled) ?? false
    );
  },

  setCompileOnSaveForEditor(editor, enabled) {
    return editor ? this.setCompileOnSaveForFile(editor.getPath(), enabled) : false;
  },

  getCompileOnSaveFiles() {
    return (this.buildService?.getObserved({ providerId: "latex-tools" }) ?? []).map(
      (entry) => entry.filePath,
    );
  },

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
    this.buildService?.associateArtifact(
      { providerId: "latex-tools", filePath: this.getRootFilePath(file) || file },
      pdfFile,
    );
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
