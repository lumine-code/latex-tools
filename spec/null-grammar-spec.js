const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Emitter } = require("lumine");

describe("latex-tools automatic builds without a grammar", () => {
  let directory, editor, main, emitter;
  beforeEach(async () => {
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "latex-tools-none-"));
    const filePath = path.join(directory, "source.tex");
    fs.writeFileSync(filePath, "source\n");
    editor = await lumine.workspace.open(filePath);
    await editor.getBuffer().getFileWatchStartPromise();
    await lumine.packages.activatePackage("tasks");
    const pkg = await lumine.packages.activatePackage("latex-tools");
    main = pkg.mainModule;
    emitter = new Emitter();
    spyOn(lumine.fileWatchClient, "watchFile").and.returnValue({
      ready: Promise.resolve(),
      closed: Promise.resolve(),
      onDidChange: (callback) => emitter.on("change", callback),
      onDidInvalidate: (callback) => emitter.on("invalidate", callback),
      onDidError: (callback) => emitter.on("error", callback),
      dispose() {
        emitter.dispose();
      },
    });
    expect(main.setCompileOnSaveForFile(filePath, true)).toBe(true);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("latex-tools");
    editor?.destroy();
    fs.unlinkSync(path.join(directory, "source.tex"));
    fs.rmdirSync(directory);
  });
  it("cancels queued automatic compilation and resumes after a grammar returns", () => {
    const compile = spyOn(main.buildService, "run");
    const grammar = editor.getGrammar();
    emitter.emit("change", []);
    editor.setGrammar(lumine.grammars.nullGrammar);
    advanceClock(200);
    expect(compile).not.toHaveBeenCalled();
    emitter.emit("invalidate");
    advanceClock(200);
    expect(compile).not.toHaveBeenCalled();
    expect(main.isCompileOnSaveEnabledForFile(editor.getPath())).toBe(true);
    editor.setGrammar(grammar);
    emitter.emit("change", []);
    advanceClock(200);
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it("lets build cancel a pending automatic job when None is selected", () => {
    const filePath = editor.getPath();
    const job = main.buildService.run({ providerId: "latex-tools", filePath, reason: "save" });
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(job.state).toBe("cancelled");
    expect(main.isCompileOnSaveEnabledForFile(filePath)).toBe(true);
  });

  it("respects closed None file associations and an open explicit grammar choice", () => {
    const compile = spyOn(main.buildService, "run");
    const grammar = editor.getGrammar();
    const extension = path.extname(editor.getPath()).slice(1);
    lumine.config.set("core.customFileTypes", {
      [lumine.grammars.nullGrammar.scopeName]: [extension],
    });
    editor.setGrammar(grammar);
    emitter.emit("change", []);
    advanceClock(200);
    expect(compile).toHaveBeenCalledTimes(1);
    compile.calls.reset();
    editor.destroy();
    emitter.emit("change", []);
    advanceClock(200);
    expect(compile).not.toHaveBeenCalled();
  });

  it("does not discover roots while querying a suspended document", () => {
    editor.setGrammar(lumine.grammars.nullGrammar);
    const discover = spyOn(main, "getRootFilePath").and.returnValue(editor.getPath());
    require("../lib/document-analysis").rootForDocument(main, editor.getPath());
    main.getBuildState(editor.getPath());
    main.checkBuildStatus(editor.getPath());
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not automatically compile a child whose root uses None", async () => {
    const rootPath = path.join(directory, "root.tex");
    fs.writeFileSync(rootPath, "root source\n");
    const rootEditor = await lumine.workspace.open(rootPath);
    try {
      rootEditor.setGrammar(lumine.grammars.nullGrammar);
      spyOn(main, "getRootFilePath").and.returnValue(rootPath);
      const compile = spyOn(main.buildService, "run");
      emitter.emit("change", []);
      advanceClock(200);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      rootEditor.destroy();
      fs.unlinkSync(rootPath);
    }
  });
});
