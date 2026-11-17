const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Emitter } = require("lumine");

describe("latex-tools automatic builds without a grammar", () => {
  let directory, filePath, editor, main, emitter, entry, previousPaths, previousFileTypes;
  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    previousFileTypes = lumine.config.get("core.customFileTypes");
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "latex-tools-none-"));
    filePath = path.join(directory, "source.tex");
    fs.writeFileSync(filePath, "source\n");
    lumine.project.setPaths([directory]);
    editor = await lumine.workspace.open(filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("text.plain"));
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
    entry = [...main.buildService.observed.values()].find((item) => item.filePath === filePath);
    await entry.observation.ready;
    await entry.observation.hasChanges();
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("latex-tools");
    editor?.destroy();
    lumine.project.setPaths(previousPaths);
    if (previousFileTypes === undefined) lumine.config.unset("core.customFileTypes");
    else lumine.config.set("core.customFileTypes", previousFileTypes);
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.unlinkSync(path.join(directory, "source.tex"));
    fs.rmdirSync(directory);
  });

  async function settleObservation() {
    await entry.observation.hasChanges();
    await timeoutPromise(200);
  }

  it("cancels queued automatic compilation and resumes after a new change with a restored grammar", async () => {
    const compile = spyOn(main.buildService, "run");
    const grammar = editor.getGrammar();
    fs.writeFileSync(filePath, "queued source revision\n");
    emitter.emit("change", []);
    editor.setGrammar(lumine.grammars.nullGrammar);
    await settleObservation();
    expect(compile).not.toHaveBeenCalled();
    fs.writeFileSync(filePath, "source changed while None is selected\n");
    emitter.emit("invalidate");
    await settleObservation();
    expect(compile).not.toHaveBeenCalled();
    expect(main.isCompileOnSaveEnabledForFile(editor.getPath())).toBe(true);
    editor.setGrammar(grammar);
    fs.writeFileSync(filePath, "new source revision after grammar restoration\n");
    emitter.emit("change", []);
    await conditionPromise(() => compile.calls.count() === 1, "a new source revision to compile");
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it("lets build cancel a pending automatic job when None is selected", () => {
    const filePath = editor.getPath();
    const job = main.buildService.run({ providerId: "latex-tools", filePath, reason: "save" });
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(job.state).toBe("cancelled");
    expect(main.isCompileOnSaveEnabledForFile(filePath)).toBe(true);
  });

  it("respects closed None file associations and an open explicit grammar choice", async () => {
    const compile = spyOn(main.buildService, "run");
    const grammar = editor.getGrammar();
    const extension = path.extname(editor.getPath()).slice(1);
    lumine.config.set("core.customFileTypes", {
      [lumine.grammars.nullGrammar.scopeName]: [extension],
    });
    editor.setGrammar(grammar);
    fs.writeFileSync(filePath, "source revision with an explicit grammar\n");
    emitter.emit("change", []);
    await conditionPromise(
      () => compile.calls.count() === 1,
      "an explicit grammar to allow compilation",
    );
    expect(compile).toHaveBeenCalledTimes(1);
    compile.calls.reset();
    editor.destroy();
    fs.writeFileSync(filePath, "source revision while the closed file uses None\n");
    emitter.emit("change", []);
    await settleObservation();
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
      fs.writeFileSync(filePath, "child source revision while its root uses None\n");
      emitter.emit("change", []);
      await settleObservation();
      expect(compile).not.toHaveBeenCalled();
    } finally {
      rootEditor.destroy();
      fs.unlinkSync(rootPath);
    }
  });
});
