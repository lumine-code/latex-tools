const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

describe("LaTeX compilation start ownership", () => {
  let main, editor, directory, filePath, children, spawn, createChild;
  let originalProjectPaths, fixtureFiles, extraEditors;

  beforeEach(async () => {
    const grammar = await lumine.packages.activatePackage("language-text");
    await grammar.resourceLoadPromise;
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "latex-start-owner-")),
    );
    originalProjectPaths = lumine.project.getPaths();
    lumine.project.setPaths([directory]);
    filePath = path.join(directory, "source.tex");
    fs.writeFileSync(filePath, "source\n");
    fixtureFiles = [filePath];
    extraEditors = [];
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    spyOn(main, "getRootFilePath").and.callFake((source) => source);
    spyOn(main, "isStatusBarActiveFor").and.returnValue(false);
    spyOn(main, "parseLogFile");
    editor = await lumine.workspace.open(filePath);
    await editor.getBuffer().getFileWatchStartPromise();
    children = [];
    createChild = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jasmine.createSpy("owned compiler kill");
      children.push(child);
      return child;
    };
    spawn = spyOn(childProcess, "spawn").and.callFake(createChild);
    // A pending build has no native child yet. Exercise the real boundary
    // before mocking termination so none of these tests can kill a real PID.
    expect(() => main.killProcess(null)).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    spyOn(main, "killProcess").and.callFake((child) => child?.kill());
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("latex-tools");
    editor?.destroy();
    for (const extraEditor of extraEditors) extraEditor.destroy();
    lumine.project.setPaths(originalProjectPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const temporary = fs.realpathSync.native(os.tmpdir());
    const owned = fs.realpathSync.native(directory);
    if (path.dirname(owned) !== temporary || !path.basename(owned).startsWith("latex-start-owner-"))
      throw new Error("LaTeX start fixture escaped its temporary root");
    for (const fixture of fixtureFiles) fs.unlinkSync(path.join(owned, path.basename(fixture)));
    fs.rmdirSync(owned);
  });

  function createFixture(name, content) {
    const fixture = path.join(directory, name);
    fs.writeFileSync(fixture, content);
    fixtureFiles.push(fixture);
    return fixture;
  }

  async function suspend(fixture) {
    const extraEditor = await lumine.workspace.open(fixture);
    await extraEditor.getBuffer().getFileWatchStartPromise();
    extraEditors.push(extraEditor);
    extraEditor.setGrammar(lumine.grammars.nullGrammar);
  }

  it("cancels a start when its public callback selects None and permits a later build", () => {
    const service = main.provideLatexTools();
    const grammar = editor.getGrammar();
    const lease = service.onDidStartBuild(() => editor.setGrammar(lumine.grammars.nullGrammar));
    try {
      main.runCompilation(filePath);
      expect(spawn).not.toHaveBeenCalled();
      expect(main.buildProcesses.has(filePath)).toBe(false);
      expect(service.isBuilding(filePath)).toBe(false);
      expect(main.getBuildState(filePath).status).toBe("idle");
    } finally {
      lease.dispose();
    }
    editor.setGrammar(grammar);
    main.runCompilation(filePath);
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].emit("exit", 0, null);
    expect(main.buildProcesses.has(filePath)).toBe(false);
    expect(service.getStatus(filePath).status).toBe("success");
  });

  it("keeps a replacement started synchronously by a public start callback", () => {
    const service = main.provideLatexTools();
    let previous;
    const lease = service.onDidStartBuild(() => {
      if (previous) return;
      previous = main.buildProcesses.get(filePath);
      expect(previous.process).toBeNull();
      main.interruptFile(filePath);
      main.runCompilation(filePath);
    });
    try {
      main.runCompilation(filePath);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(main.buildProcesses.get(filePath)).not.toBe(previous);
      expect(main.buildProcesses.get(filePath).process).toBe(children[0]);
      expect(service.isBuilding(filePath)).toBe(true);
      children[0].emit("exit", 0, null);
      expect(service.getStatus(filePath).status).toBe("success");
    } finally {
      lease.dispose();
    }
  });

  it("reaps a child returned after its pending start was cancelled and ignores late events", () => {
    const service = main.provideLatexTools();
    spawn.and.callFake(() => {
      const child = createChild();
      editor.setGrammar(lumine.grammars.nullGrammar);
      return child;
    });
    main.runCompilation(filePath);
    const child = children[0];
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(main.buildProcesses.has(filePath)).toBe(false);
    expect(service.isBuilding(filePath)).toBe(false);
    expect(() => child.emit("error", new Error("late compiler error"))).not.toThrow();
    child.emit("exit", 0, null);
    expect(main.getBuildState(filePath).status).toBe("idle");
  });

  it("clears pending ownership on a synchronous spawn failure and permits a restart", () => {
    const service = main.provideLatexTools();
    spawn.and.throwError("controlled compiler launch failure");
    const error = spyOn(lumine.notifications, "addError").and.callThrough();
    expect(() => main.runCompilation(filePath)).not.toThrow();
    expect(error).toHaveBeenCalled();
    expect(main.buildProcesses.has(filePath)).toBe(false);
    expect(service.isBuilding(filePath)).toBe(false);
    spawn.and.callFake(createChild);
    main.runCompilation(filePath);
    children[0].emit("exit", 0, null);
    expect(service.getStatus(filePath).status).toBe("success");
  });

  it("continues to allow an explicit compilation after None was already selected", () => {
    editor.setGrammar(lumine.grammars.nullGrammar);
    main.runCompilation(filePath);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(main.buildProcesses.get(filePath).process).toBe(children[0]);
  });

  it("does not read a suspended sibling root or its recorder during root discovery", async () => {
    const candidate = createFixture("suspended.tex", "\\documentclass{article}\n\\input{source}");
    const recorder = createFixture("suspended.fls", `INPUT ${filePath}\n`);
    await suspend(candidate);
    const read = spyOn(fs, "readFileSync").and.callThrough();
    expect(main.findRootCandidatesForFile(filePath)).toEqual([]);
    const inputs = read.calls.allArgs().map(([input]) => String(input));
    expect(inputs).not.toContain(candidate);
    expect(inputs).not.toContain(recorder);
  });

  it("does not read a suspended included source while inspecting another candidate", async () => {
    const candidate = createFixture("root.tex", "\\documentclass{article}\n\\input{bridge}");
    const included = createFixture("bridge.tex", "\\input{source}");
    await suspend(included);
    const read = spyOn(fs, "readFileSync").and.callThrough();
    expect(main.findRootCandidatesForFile(filePath)).toEqual([]);
    const inputs = read.calls.allArgs().map(([input]) => String(input));
    expect(inputs).toContain(candidate);
    expect(inputs).not.toContain(included);
  });
});
