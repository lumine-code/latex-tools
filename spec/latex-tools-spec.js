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
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    tempDirs = [];
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    await lumine.packages.activatePackage("tasks");
    const pack = await lumine.packages.activatePackage("latex-tools");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    mainModule.clearCompileOnSaveFiles();
    await lumine.fileWatchClient.settlePendingTeardown();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
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

  describe("provided synchronization service", () => {
    it("exposes only SyncTeX while the shared build service owns compilation", () => {
      expect(Object.keys(mainModule.provideSynctex()).sort()).toEqual([
        "syncToPdf",
        "syncToSource",
      ]);
      expect(mainModule.buildService).toBeTruthy();
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

  describe("PDF document compilation", () => {
    it("compiles an existing source without an open editor", async () => {
      const directory = makeTempDir();
      const sourceFile = path.join(directory, "document.tex");
      fs.writeFileSync(sourceFile, "content");
      const event = {
        context: { documentItem: { filePath: sourceFile.replace(/\.tex$/, ".pdf") } },
      };
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);
      spyOn(lumine.workspace, "getTextEditors").and.returnValue([]);
      spyOn(mainModule, "checkBuildStatus").and.returnValue(false);
      spyOn(mainModule, "runCompilation");

      await mainModule.compile(event);

      expect(mainModule.runCompilation).toHaveBeenCalledWith(sourceFile);
    });

    it("recreates a removed child before resolving and saving its root", async () => {
      const directory = makeTempDir();
      const childFile = path.join(directory, "child.tex");
      const rootFile = path.join(directory, "root.tex");
      fs.writeFileSync(rootFile, "root before save");
      const event = {
        context: { documentItem: { filePath: childFile.replace(/\.tex$/, ".pdf") } },
      };
      spyOn(lumine.workspace, "getActiveTextEditor").and.returnValue(null);

      let finishRootSave;
      const childEditor = {
        isDestroyed: () => false,
        getPath: () => childFile,
        getFileState: () => "removed",
        save: jasmine.createSpy("save-child").and.callFake(async () => {
          fs.writeFileSync(childFile, "% !TEX root = root.tex\nchild");
        }),
      };
      const rootEditor = {
        isDestroyed: () => false,
        getPath: () => rootFile,
        getFileState: () => "modified",
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

      const compiling = mainModule.compile(event);
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

  describe("forward SyncTeX", () => {
    let sourceEditor;

    afterEach(() => {
      sourceEditor?.destroy();
    });

    it("opens the PDF and returns focus to its source", async () => {
      const sourceFile = path.join(makeTempDir(), "document.tex");
      const pdfFile = sourceFile.replace(/\.tex$/, ".pdf");
      fs.writeFileSync(sourceFile, "source");
      sourceEditor = await lumine.workspace.open(sourceFile);
      const sourceView = lumine.views.getView(sourceEditor);
      const focusSource = spyOn(sourceView, "focus");
      const viewer = {
        whenReady: jasmine.createSpy("whenReady").and.returnValue(Promise.resolve()),
        scrollToPosition: jasmine.createSpy("scrollToPosition"),
      };
      spyOn(mainModule, "syncToPdf").and.returnValue(
        Promise.resolve({ pdfPath: pdfFile, page: 3, x: 12, y: 34 }),
      );
      const open = spyOn(lumine.workspace, "open").and.returnValue(Promise.resolve(viewer));

      await mainModule.synctex();

      expect(open).toHaveBeenCalledWith(pdfFile, {
        split: "right",
        searchAllPanes: true,
      });
      expect(viewer.whenReady).toHaveBeenCalled();
      expect(viewer.scrollToPosition).toHaveBeenCalledWith(2, 12, 34);
      expect(focusSource).toHaveBeenCalled();
    });
  });

  describe("compile-on-save observation", () => {
    it("delegates observed files and their events to the build service", () => {
      const dir = makeTempDir();
      const file = path.join(dir, "doc.tex");
      fs.writeFileSync(file, "\\documentclass{article}");

      const changes = [];
      const disposable = mainModule.buildService.onDidChangeObserved((data) => changes.push(data));

      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(true);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([path.resolve(file)]);

      // Enabling twice is a no-op.
      expect(mainModule.setCompileOnSaveForFile(file, true)).toBe(false);

      expect(mainModule.setCompileOnSaveForFile(file, false)).toBe(true);
      expect(mainModule.isCompileOnSaveEnabledForFile(file)).toBe(false);
      expect(mainModule.getCompileOnSaveFiles()).toEqual([]);

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
      const LogParser = require("../lib/log-parser");
      parser = new LogParser();
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

  describe("diagnostics collected by build", () => {
    it("retains detailed log ranges and applies the LaTeX verbosity policy", () => {
      const file = path.join(makeTempDir(), "document.tex");
      fs.writeFileSync(file, "\\documentclass{article}\n");
      fs.writeFileSync(
        file.replace(/\.tex$/, ".log"),
        [
          "This is pdfTeX",
          "LaTeX Warning: Reference undefined on input line 3",
          "",
          "Overfull \\hbox (1.0pt too wide) at lines 4--4",
          "",
          "Package geometry Info: Driver auto-setting on input line 5",
          "",
        ].join("\n"),
      );
      const { diagnosticsFor, snapshotDiagnostics } = require("../lib/latex-target");
      const result = { code: 0, plan: { diagnosticSnapshot: snapshotDiagnostics(file) } };
      lumine.config.set("latex-tools.outputVerbosity", "default");
      expect(diagnosticsFor(file, result).map((message) => message.severity)).toEqual(["warning"]);
      lumine.config.set("latex-tools.outputVerbosity", "extended");
      const messages = diagnosticsFor(file, result);
      expect(messages.map((message) => message.severity)).toEqual(["warning", "info", "hint"]);
      expect(messages[0].location.file).toBe(file);
      expect(messages[0].reference.file).toBe(file.replace(/\.tex$/, ".log"));
    });
  });
});
