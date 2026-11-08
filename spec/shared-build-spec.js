const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("LaTeX compilation through the shared Tasks service", () => {
  let main, service, directory, source, children, spawn, editors;
  beforeEach(async () => {
    jasmine.useRealClock();
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    service = main.buildService;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "latex-shared-build-"));
    source = path.join(directory, "document.tex");
    fs.writeFileSync(source, "% !TEX program = xelatex\n\\documentclass{article}\n");
    children = [];
    editors = [];
    const nativeSpawn = childProcess.spawn;
    spawn = spyOn(childProcess, "spawn").and.callFake((command, ...args) => {
      if (command !== "latexmk") return nativeSpawn.call(childProcess, command, ...args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jasmine.createSpy("stop compiler").and.callFake((signal) => {
        child.emit("close", null, signal);
      });
      children.push(child);
      return child;
    });
  });

  function latestCompilerCall() {
    return spawn.calls
      .all()
      .filter((call) => call.args[0] === "latexmk")
      .at(-1);
  }
  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("latex-tools");
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-shared-build-")
    )
      throw new Error("Unsafe fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true });
  });

  it("declares the PDF before launch and gives build the latexmk command and parsed log", async () => {
    const starts = [];
    const lease = service.onDidStartJob((job) =>
      starts.push(job.artifacts.map((artifact) => ({ ...artifact }))),
    );
    const job = main.providePdfBuildProvider().build(source);
    await flushMicrotasks();
    expect(children.length).toBe(1);
    expect(latestCompilerCall().args[0]).toBe("latexmk");
    expect(latestCompilerCall().args[1]).toContain("-xelatex");
    expect(latestCompilerCall().args[1].at(-1)).toBe("document.tex");
    expect(starts).toEqual([
      [{ path: source.replace(/\.tex$/, ".pdf"), kind: "pdf", sourcePath: source }],
    ]);
    fs.writeFileSync(
      source.replace(/\.tex$/, ".log"),
      "This is XeTeX\nLaTeX Warning: Reference undefined on input line 3\n",
    );
    children[0].stdout.emit("data", Buffer.from("latexmk output\n"));
    children[0].emit("close", 0, null);
    await job.completion;
    expect(job.state).toBe("passed");
    expect(job.stdout).toBe("latexmk output\n");
    expect(
      service.getMessages({ providerId: "latex-tools", filePath: source })[0].location
        .position[0][0],
    ).toBe(2);
    expect(main.getBuildState(source).status).toBe("success");
    lease.dispose();
  });

  for (const [code, state] of [
    [0, "passed"],
    [12, "failed"],
  ]) {
    it(`keeps ${state} command compilation in the background`, async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const build = (await lumine.packages.activatePackage("tasks")).mainModule;
      const ensurePanel = spyOn(build, "ensurePanel").and.callThrough();
      const editor = await lumine.workspace.open(source);
      editors.push(editor);
      expect(build.panel).toBeNull();
      expect(build.isTasksPanelVisible()).toBeFalse();
      expect(lumine.commands.canDispatch(editor.getElement(), "latex-tools:compile")).toBeTrue();

      await lumine.commands.dispatch(editor.getElement(), "latex-tools:compile");
      const job = service.getJob({ providerId: "latex-tools", filePath: source });
      expect(job).toBeTruthy();
      await conditionPromise(() => job.state === "running", "background LaTeX compilation");
      expect(ensurePanel).not.toHaveBeenCalled();
      fs.writeFileSync(
        source.replace(/\.tex$/, ".log"),
        code
          ? "This is XeTeX\n! Undefined control sequence.\nl.5 \\badcommand\n"
          : "This is XeTeX\n",
      );
      children[0].stdout.emit("data", Buffer.from("command compilation output\n"));
      children[0].emit("close", code, null);
      await job.completion;

      expect(job.state).toBe(state);
      expect(job.stdout).toBe("command compilation output\n");
      expect(service.getJobs({ providerId: "latex-tools" })).toContain(job);
      expect(ensurePanel).not.toHaveBeenCalled();
      expect(build.panel).toBeNull();
      expect(build.isTasksPanelVisible()).toBeFalse();
      expect(build.statusNewIndicator.hidden).toBeFalse();
      expect(build.statusElement.dataset.new).toBe("1");
      expect(build.statusElement.dataset.state).toBe(state);
    });
  }

  it("uses one job for a root and its child and keeps other documents independent", async () => {
    const child = path.join(directory, "chapter.tex");
    const other = path.join(directory, "other.tex");
    fs.writeFileSync(child, "% !TEX root = document.tex\nChapter\n");
    fs.writeFileSync(other, "\\documentclass{article}\n");
    const rootJob = service.run({ providerId: "latex-tools", filePath: child, reason: "manual" });
    expect(main.runCompilation(source)).toBe(rootJob);
    const otherJob = main.runCompilation(other);
    await flushMicrotasks();
    expect(children.length).toBe(2);
    expect(service.getJobs({ providerId: "latex-tools", activeOnly: true }).length).toBe(2);
    children[0].emit("close", 0, null);
    children[1].emit("close", 0, null);
    await Promise.all([rootJob.completion, otherJob.completion]);
  });

  it("saves the selected chapter before resolving its changed root from the Tasks target picker", async () => {
    const childPath = path.join(directory, "chapter.tex");
    const rootPath = path.join(directory, "new-root.tex");
    const unrelatedPath = path.join(directory, "unrelated.txt");
    fs.writeFileSync(childPath, "% !TEX root = document.tex\nOld chapter\n");
    fs.writeFileSync(rootPath, "\\documentclass{article}\nOld root\n");
    fs.writeFileSync(unrelatedPath, "Old unrelated content\n");
    const rootEditor = await lumine.workspace.open(rootPath);
    editors.push(rootEditor);
    const rootText = "% !TEX program = lualatex\n\\documentclass{article}\nNew root\n";
    rootEditor.setText(rootText);
    const unrelatedEditor = await lumine.workspace.open(unrelatedPath);
    editors.push(unrelatedEditor);
    unrelatedEditor.setText("Unrelated unsaved change\n");
    const childEditor = await lumine.workspace.open(childPath);
    editors.push(childEditor);
    const childText = "% !TEX root = new-root.tex\nNew chapter\n";
    childEditor.setText(childText);
    const build = (await lumine.packages.activatePackage("tasks")).mainModule;
    lumine.config.set("tasks.saveOnBuild", true);
    await build.refreshTargets();
    const target = build.targets.find((candidate) => candidate.providerId === "latex-tools");
    expect(target.filePath).toBe(childPath);
    let startedLease;
    const started = new Promise((resolve) => {
      startedLease = service.onDidStartJob((job) => {
        if (job.providerId === "latex-tools") resolve(job);
      });
    });
    try {
      const job = await build.runTarget(target);
      await started;
      await flushMicrotasks();
      expect(job.filePath).toBe(rootPath);
      expect(fs.readFileSync(childPath, "utf8")).toBe(childText);
      expect(fs.readFileSync(rootPath, "utf8")).toBe(rootText);
      expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("Old unrelated content\n");
      expect(latestCompilerCall().args[1]).toContain("-lualatex");
      expect(latestCompilerCall().args[1].at(-1)).toBe("new-root.tex");
      children[0].emit("close", 0, null);
      await job.completion;
    } finally {
      startedLease.dispose();
    }
  });

  it("withdraws its provider, jobs and observations when deactivated", async () => {
    main.setCompileOnSaveForFile(source, true);
    const job = main.runCompilation(source);
    await flushMicrotasks();
    expect(children.length).toBe(1);
    await lumine.packages.deactivatePackage("latex-tools");
    await job.completion;
    expect(job.state).toBe("cancelled");
    expect(children[0].kill).toHaveBeenCalled();
    expect(service.getObserved({ providerId: "latex-tools" })).toEqual([]);
    expect(
      service.run({ providerId: "latex-tools", filePath: source, reason: "manual" }),
    ).toBeNull();
  });

  it("cleans successful builds after collecting diagnostics and retaining recorder dependencies", async () => {
    lumine.config.set("latex-tools.cleanAuxFiles", true);
    lumine.config.set("latex-tools.cleanExtensions", ["{basename}.*"]);
    main.setCompileOnSaveForFile(source, true);
    const job = main.runCompilation(source);
    await flushMicrotasks();
    expect(latestCompilerCall().args[1]).not.toContain("-c");
    const bibliography = path.join(directory, "references.bib");
    const figure = path.join(directory, "figure.pdf");
    const output = source.replace(/\.tex$/, ".pdf");
    const sync = source.replace(/\.tex$/, ".synctex.gz");
    const auxiliary = source.replace(/\.tex$/, ".aux");
    const log = source.replace(/\.tex$/, ".log");
    const recorder = source.replace(/\.tex$/, ".fls");
    for (const file of [bibliography, figure, output, sync, auxiliary])
      fs.writeFileSync(file, "owned fixture");
    fs.writeFileSync(log, "This is XeTeX\nLaTeX Warning: Reference undefined on input line 3\n");
    fs.writeFileSync(recorder, `INPUT ${bibliography}\nINPUT ${figure}\nINPUT ${auxiliary}\n`);
    children[0].emit("close", 0, null);
    await job.completion;
    expect(job.state).toBe("passed");
    expect(job.diagnostics[0].severity).toBe("warning");
    expect(job.diagnostics[0].location.position[0][0]).toBe(2);
    expect(job.diagnostics[0].reference).toBeUndefined();
    for (const file of [source, output, sync, bibliography, figure])
      expect(fs.existsSync(file)).toBe(true);
    for (const file of [auxiliary, log, recorder]) expect(fs.existsSync(file)).toBe(false);
    expect(main.getWatchPaths(source)).toContain(bibliography);
    expect(main.getWatchPaths(source)).toContain(figure);
    expect(main.getWatchPaths(source)).not.toContain(auxiliary);
  });

  it("retains a failed build's log and auxiliary files for investigation", async () => {
    lumine.config.set("latex-tools.cleanAuxFiles", true);
    const job = main.runCompilation(source);
    await flushMicrotasks();
    const log = source.replace(/\.tex$/, ".log");
    const auxiliary = source.replace(/\.tex$/, ".aux");
    fs.writeFileSync(log, "This is XeTeX\n! Undefined control sequence.\nl.5 \\badcommand\n");
    fs.writeFileSync(auxiliary, "owned auxiliary");
    children[0].emit("close", 12, null);
    await job.completion;
    expect(job.state).toBe("failed");
    expect(job.diagnostics[0].excerpt).toBe("Undefined control sequence.");
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.existsSync(auxiliary)).toBe(true);
  });

  for (const kind of ["source", "pdf"]) {
    it(`cancels a pending ${kind} cleanup when its package generation retires`, async () => {
      let finish;
      const job = {
        state: "running",
        stop: jasmine.createSpy("stop"),
        completion: new Promise((resolve) => {
          finish = resolve;
        }),
      };
      spyOn(service, "getJob").and.returnValue(job);
      spyOn(main, "commandEditor").and.returnValue({ getPath: () => source });
      spyOn(main, "commandDocument").and.returnValue({ filePath: source, pdf: kind === "pdf" });
      spyOn(main, "getRootFilePath").and.returnValue(source);
      const clean = spyOn(main, "cleanFile");
      const cleaning = main.killAndClean();
      expect(job.stop).toHaveBeenCalled();
      await lumine.packages.deactivatePackage("latex-tools");
      main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
      finish();
      await cleaning;
      expect(clean).not.toHaveBeenCalled();
    });
  }

  it("finds chapter dependencies before a recorder exists and excludes generated auxiliary inputs", () => {
    const child = path.join(directory, "chapter.tex");
    const auxiliary = path.join(directory, "document.aux");
    const bibliography = path.join(directory, "references.bib");
    const figure = path.join(directory, "figure.pdf");
    const output = source.replace(/\.tex$/, ".pdf");
    fs.writeFileSync(source, "\\documentclass{article}\n\\input{chapter}\n");
    fs.writeFileSync(child, "Chapter\n");
    expect(main.getWatchPaths(source)).toEqual([source, child]);
    fs.writeFileSync(auxiliary, "generated data");
    fs.writeFileSync(bibliography, "@book{example, title={Example}}\n");
    fs.writeFileSync(figure, "input figure");
    fs.writeFileSync(output, "generated PDF");
    fs.writeFileSync(
      source.replace(/\.tex$/, ".fls"),
      `INPUT ${auxiliary}\nINPUT ${bibliography}\nINPUT ${figure}\nINPUT ${output}\n`,
    );
    expect(main.getWatchPaths(source)).toContain(bibliography);
    expect(main.getWatchPaths(source)).toContain(figure);
    expect(main.getWatchPaths(source)).not.toContain(auxiliary);
    expect(main.getWatchPaths(source)).not.toContain(output);
  });
});
