const path = require("path");
const fs = require("fs");
const os = require("os");

describe("latex-tools", () => {
  let workspaceElement, mainModule, tempDirs;

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-tools-spec-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    tempDirs = [];
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    const pack = await lumine.packages.activatePackage("latex-tools");
    mainModule = pack.mainModule;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        // Retries because Windows keeps a directory non-empty until the last handle on a
        // child closes, and `force` swallows only ENOENT.
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Windows can refuse to delete recently watched directories.
      }
    }
  });

  describe("command registration", () => {
    it("registers the workspace commands", () => {
      const commands = lumine.commands
        .findCommands({ target: workspaceElement })
        .map((command) => command.name);
      for (const name of [
        "latex-tools:global-rc",
        "latex-tools:observed-files",
        "latex-tools:clear-all-observed-files",
      ]) {
        expect(commands).toContain(name);
      }
    });

    it("registers the build commands on latex editors", async () => {
      const editor = await lumine.workspace.open();
      const editorElement = lumine.views.getView(editor);
      editorElement.dataset.grammar = "text tex latex";
      const commands = lumine.commands
        .findCommands({ target: editorElement })
        .map((command) => command.name);
      for (const name of [
        "latex-tools:compile",
        "latex-tools:open-pdf",
        "latex-tools:open-pdf-external",
        "latex-tools:clean",
        "latex-tools:clean-linter",
        "latex-tools:interrupt",
        "latex-tools:interrupt-all",
        "latex-tools:kill-and-clean",
        "latex-tools:toggle-compile-on-save",
        "latex-tools:synctex",
      ]) {
        expect(commands).toContain(name);
      }
    });
  });

  describe("provided latex-tools service", () => {
    let service;

    beforeEach(() => {
      service = mainModule.provideLatexTools();
    });

    it("exposes the API consumed by pdf-view", () => {
      // pdf-view calls compile() and syncToSource() and subscribes to the
      // three build events.
      for (const method of [
        "compile",
        "syncToSource",
        "syncToPdf",
        "onDidStartBuild",
        "onDidFinishBuild",
        "onDidFailBuild",
        "onDidChangeBuildStatus",
        "onDidUpdateMessages",
        "onDidChangeCompileOnSave",
        "getStatus",
        "isBuilding",
        "interrupt",
        "interruptAll",
        "getMessages",
        "getMessageStatistics",
        "getOutputPath",
        "openPdf",
        "openPdfExternal",
        "setCompileOnSave",
        "isCompileOnSaveEnabled",
        "getCompileOnSaveEditors",
        "getCompileOnSaveFiles",
      ]) {
        expect(typeof service[method]).toBe("function");
      }
    });

    it("emits build lifecycle events with the file payload", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.tex");
      fs.writeFileSync(file, "\\documentclass{article}\\begin{document}x\\end{document}");

      const started = [];
      const finished = [];
      const failed = [];
      const disposables = [
        service.onDidStartBuild((data) => started.push(data)),
        service.onDidFinishBuild((data) => finished.push(data)),
        service.onDidFailBuild((data) => failed.push(data)),
      ];

      service.startBuild(file);
      expect(started).toEqual([{ file }]);
      expect(service.isBuilding(file)).toBe(true);
      expect(service.getStatus(file).status).toBe("building");

      service.finishBuild(file, "stdout text", 42);
      expect(finished.length).toBe(1);
      expect(finished[0].file).toBe(file);
      expect(service.getStatus(file).status).toBe("success");

      service.startBuild(file);
      service.failBuild(file, "Exit code 12", "log");
      expect(failed.length).toBe(1);
      expect(failed[0].error).toBe("Exit code 12");
      expect(service.getStatus(file).status).toBe("error");

      for (const disposable of disposables) {
        disposable.dispose();
      }
      service.reset();
    });

    it("delegates compile() to the main module for .tex files only", () => {
      spyOn(mainModule, "runCompilation");
      expect(service.compile("/tmp/doc.txt")).toBe(false);
      expect(service.compile(null)).toBe(false);
      expect(mainModule.runCompilation).not.toHaveBeenCalled();

      const dir = makeTempDir();
      const file = path.join(dir, "doc.tex");
      fs.writeFileSync(file, "\\documentclass{article}");
      expect(service.compile(file)).toBe(true);
      expect(mainModule.runCompilation).toHaveBeenCalledWith(file);
    });
  });

  describe("root document resolution", () => {
    it("resolves the root from a magic comment", () => {
      const dir = makeTempDir();
      const rootFile = path.join(dir, "root.tex");
      const childFile = path.join(dir, "child.tex");
      fs.writeFileSync(rootFile, "\\documentclass{article}\\begin{document}\\end{document}");
      fs.writeFileSync(childFile, "% !TEX root = root.tex\nSome content\n");
      expect(mainModule.resolveTexRoot(childFile)).toBe(rootFile);
    });

    it("resolves the root by scanning for including documents", () => {
      const dir = makeTempDir();
      const rootFile = path.join(dir, "main.tex");
      const childFile = path.join(dir, "chapter.tex");
      fs.writeFileSync(
        rootFile,
        "\\documentclass{article}\\begin{document}\\input{chapter}\\end{document}",
      );
      fs.writeFileSync(childFile, "Chapter content\n");
      expect(mainModule.resolveTexRoot(childFile)).toBe(rootFile);
    });

    it("falls back to the file itself for standalone documents", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "solo.tex");
      fs.writeFileSync(file, "\\documentclass{article}\\begin{document}\\end{document}");
      expect(mainModule.resolveTexRoot(file)).toBe(file);
      expect(mainModule.getPdfPathForFile(file)).toBe(file.replace(/\.tex$/, ".pdf"));
    });
  });

  describe("status-bar compilation", () => {
    it("compiles an existing source without an open editor", async () => {
      const directory = makeTempDir();
      const sourceFile = path.join(directory, "document.tex");
      fs.writeFileSync(sourceFile, "content");
      mainModule.currentTexFile = sourceFile;
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);
      spyOn(lumine.workspace, "getTextEditors").and.returnValue([]);
      spyOn(mainModule, "checkBuildStatus").and.returnValue(false);
      spyOn(mainModule, "runCompilation");

      await mainModule.compileFromStatusBar();

      expect(mainModule.runCompilation).toHaveBeenCalledWith(sourceFile);
    });

    it("recreates a removed child before resolving and saving its root", async () => {
      const directory = makeTempDir();
      const childFile = path.join(directory, "child.tex");
      const rootFile = path.join(directory, "root.tex");
      fs.writeFileSync(rootFile, "root before save");
      mainModule.currentTexFile = childFile;
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);

      let finishRootSave;
      const childEditor = {
        getPath: () => childFile,
        getFileState: () => lumine.FileState.REMOVED,
        save: jasmine.createSpy("save-child").and.callFake(async () => {
          fs.writeFileSync(childFile, "% !TEX root = root.tex\nchild");
        }),
      };
      const rootEditor = {
        getPath: () => rootFile,
        getFileState: () => lumine.FileState.MODIFIED,
        save: jasmine.createSpy("save-root").and.callFake(
          () =>
            new Promise((resolve) => {
              finishRootSave = resolve;
            }),
        ),
      };
      spyOn(lumine.workspace, "getTextEditors").and.returnValue([childEditor, rootEditor]);
      spyOn(mainModule, "checkBuildStatus").and.returnValue(false);
      spyOn(mainModule, "runCompilation");

      const compiling = mainModule.compileFromStatusBar();
      await Promise.resolve();
      await Promise.resolve();
      expect(childEditor.save).toHaveBeenCalled();
      expect(rootEditor.save).toHaveBeenCalled();
      expect(mainModule.runCompilation).not.toHaveBeenCalled();

      finishRootSave();
      await compiling;
      expect(mainModule.runCompilation).toHaveBeenCalledWith(rootFile);
    });
  });

  describe("compile-on-save observation", () => {
    it("observes and unobserves files, emitting service events", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.tex");
      fs.writeFileSync(file, "\\documentclass{article}");

      const changes = [];
      const disposable = mainModule.buildService.onDidChangeCompileOnSave((data) =>
        changes.push(data),
      );

      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(true);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([path.resolve(file)]);
      expect(mainModule.observedFilesStatusView.count).toBe(1);

      // Enabling twice is a no-op.
      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(false);

      expect(mainModule.setCompileOnSaveForFile(file, false)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(false);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([]);
      expect(mainModule.observedFilesStatusView.count).toBe(0);

      expect(changes.map((c) => c.enabled)).toEqual([true, false]);
      disposable.dispose();
    });

    it("rejects non-tex files", () => {
      expect(mainModule.setCompileOnSaveForFile("/tmp/doc.txt", true)).toBe(false);
      expect(mainModule.isCompileOnSaveEnabledForFile("/tmp/doc.txt")).toBe(false);
    });
  });

  describe("clean command", () => {
    it("removes auxiliary files but keeps source and PDF", () => {
      const dir = makeTempDir();
      const write = (name) => fs.writeFileSync(path.join(dir, name), "x");
      write("doc.tex");
      write("doc.pdf");
      write("doc.aux");
      write("doc.log");
      write("doc.out");
      write("other.aux");

      mainModule.cleanFile(path.join(dir, "doc.tex"));

      const remaining = fs.readdirSync(dir).sort();
      expect(remaining).toEqual(["doc.pdf", "doc.tex", "other.aux"]);
    });
  });

  describe("log parser", () => {
    let parser;

    beforeEach(() => {
      parser = mainModule.logParser;
    });

    it("parses fatal errors with line context", () => {
      const log = [
        "This is pdfTeX, Version 3.14",
        "! Undefined control sequence.",
        "l.5 \\badcommand",
        "",
      ].join("\n");
      const messages = parser.parse(log, "/proj/doc.tex");
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("error");
      expect(messages[0].excerpt).toBe("Undefined control sequence.");
      expect(messages[0].location.position.start.row).toBe(4);
    });

    it("parses file:line:message errors", () => {
      const log = [
        "This is pdfTeX, Version 3.14",
        "./doc.tex:12: Undefined control sequence.",
        "",
      ].join("\n");
      const messages = parser.parse(log, "/proj/doc.tex");
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("error");
      expect(messages[0].location.position.start.row).toBe(11);
      expect(messages[0].location.fullPath).toBe(path.resolve("/proj", "./doc.tex"));
    });

    it("parses package warnings with input line numbers", () => {
      const log = [
        "This is pdfTeX, Version 3.14",
        "Package hyperref Warning: Token not allowed on input line 42",
        "",
      ].join("\n");
      const messages = parser.parse(log, "/proj/doc.tex");
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("warning");
      expect(messages[0].excerpt).toContain("Package hyperref");
      expect(messages[0].location.position.start.row).toBe(41);
    });

    it("parses overfull box messages as info", () => {
      const log = [
        "This is pdfTeX, Version 3.14",
        "Overfull \\hbox (12.0pt too wide) in paragraph at lines 8--9",
        "",
      ].join("\n");
      const messages = parser.parse(log, "/proj/doc.tex");
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("info");
      expect(messages[0].location.position.start.row).toBe(7);
      expect(messages[0].location.position.end.row).toBe(8);
    });

    it("parses package info messages as hints", () => {
      const log = [
        "This is pdfTeX, Version 3.14",
        "Package hyperref Info: Option 'colorlinks' set on input line 6",
        "",
      ].join("\n");
      const messages = parser.parse(log, "/proj/doc.tex");
      expect(messages.length).toBe(1);
      expect(messages[0].severity).toBe("hint");
      expect(messages[0].excerpt).toContain("Package hyperref");
      expect(messages[0].location.position.start.row).toBe(5);
    });

    it("computes statistics across severities", () => {
      const log = [
        "This is pdfTeX, Version 3.14",
        "! Some error.",
        "",
        "LaTeX Warning: Reference undefined on input line 3",
        "",
        "Overfull \\hbox (1.0pt too wide) at lines 4--4",
        "",
        "Package geometry Info: Driver auto-setting on input line 5",
        "",
      ].join("\n");
      parser.parse(log, "/proj/doc.tex");
      const stats = parser.getStatistics();
      expect(stats.errors).toBe(1);
      expect(stats.warnings).toBe(1);
      expect(stats.info).toBe(1);
      expect(stats.hints).toBe(1);
    });
  });

  describe("utils", () => {
    const { detectEngineFromMagicComment, detectRootFromMagicComment, matchesPattern } = require(
      path.join(__dirname, "..", "lib", "utils"),
    );

    it("detects the engine magic comment", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.tex");
      fs.writeFileSync(file, "% !TEX program = xelatex\n\\documentclass{article}\n");
      expect(detectEngineFromMagicComment(file)).toBe("xelatex");
    });

    it("ignores unknown engines and missing comments", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.tex");
      fs.writeFileSync(file, "% !TEX program = tectonic\n\\documentclass{article}\n");
      expect(detectEngineFromMagicComment(file)).toBe(null);
      fs.writeFileSync(file, "\\documentclass{article}\n");
      expect(detectEngineFromMagicComment(file)).toBe(null);
      expect(detectEngineFromMagicComment(path.join(dir, "missing.tex"))).toBe(null);
    });

    it("detects the root magic comment and appends .tex when missing", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "child.tex");
      fs.writeFileSync(file, "% !TEX root = ../main\n");
      expect(detectRootFromMagicComment(file)).toBe(path.resolve(dir, "..", "main.tex"));
    });

    it("matches wildcard clean patterns", () => {
      expect(matchesPattern("doc.aux", "*.aux", "doc")).toBe(true);
      expect(matchesPattern("doc.bcf-junk", "*.bcf*", "doc")).toBe(true);
      expect(matchesPattern("doc.tex", "*.aux", "doc")).toBe(false);
      expect(matchesPattern("doc.mtc3", "{basename}.mtc?", "doc")).toBe(true);
    });
  });

  describe("linter integration", () => {
    it("registers an indie linter through the linter.registry service", () => {
      const registered = [];
      mainModule.consumeLinterRegistry((options) => {
        registered.push(options);
        return { setAllMessages() {}, clearMessages() {}, dispose() {} };
      });
      expect(registered).toEqual([{ name: "LaTeX" }]);
      expect(mainModule.linterProvider.indieInstance).toBeTruthy();
    });

    describe("verbosity filtering", () => {
      let sent;

      function message(severity) {
        return {
          severity,
          excerpt: `a ${severity} message`,
          location: {
            fullPath: "/proj/doc.tex",
            position: { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } },
          },
        };
      }

      function setAll() {
        mainModule.linterProvider.setMessages([
          message("error"),
          message("warning"),
          message("info"),
          message("hint"),
        ]);
        return sent.map((msg) => msg.severity);
      }

      beforeEach(() => {
        sent = [];
        mainModule.consumeLinterRegistry(() => ({
          setAllMessages(messages) {
            sent = messages;
          },
          clearMessages() {},
          dispose() {},
        }));
      });

      it("drops both low-priority tiers below extended verbosity", () => {
        lumine.config.set("latex-tools.outputVerbosity", "default");
        expect(setAll()).toEqual(["error", "warning"]);
      });

      it("keeps info and hint messages when verbosity is extended", () => {
        lumine.config.set("latex-tools.outputVerbosity", "extended");
        expect(setAll()).toEqual(["error", "warning", "info", "hint"]);
      });
    });
  });

  describe("status bar integration", () => {
    it("adds left and right tiles through the status-bar service", () => {
      const left = [];
      const right = [];
      mainModule.consumeStatusBar({
        addLeftTile(tile) {
          left.push(tile);
          return { destroy() {} };
        },
        addRightTile(tile) {
          right.push(tile);
          return { destroy() {} };
        },
      });
      expect(left.length).toBe(1);
      expect(left[0].item.classList.contains("latex-tools-status")).toBe(true);
      expect(right.length).toBe(1);
      expect(right[0].item.classList.contains("latex-tools-observed-status")).toBe(true);
    });

    it("marks the label when compile-on-save is enabled", () => {
      const view = mainModule.statusBarView;
      view.setCompileOnSave(true);
      expect(view.label.textContent).toBe("TeX*");
      view.setCompileOnSave(false);
      expect(view.label.textContent).toBe("TeX");
    });
  });

  describe("open-external integration", () => {
    it("opens the PDF through the consumed service", async () => {
      const dir = makeTempDir();
      const texFile = path.join(dir, "doc.tex");
      const pdfFile = path.join(dir, "doc.pdf");
      fs.writeFileSync(texFile, "\\documentclass{article}");
      fs.writeFileSync(pdfFile, "%PDF-1.4");

      const opened = [];
      const disposable = mainModule.consumeOpenExternal({
        openExternal(target) {
          opened.push(target);
          return Promise.resolve();
        },
      });

      const ok = await mainModule.openPdfExternalForFile(texFile);
      expect(ok).toBe(true);
      expect(opened).toEqual([pdfFile]);

      disposable.dispose();
      expect(mainModule.openExternalService).toBe(null);
    });
  });
});
