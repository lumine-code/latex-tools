const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("LaTeX automatic compilation source paths", () => {
  let main, service, directory, source, chapter, figure, image, bibliography;
  let children, leases, previousPaths;
  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-observed-inputs-")));
    source = path.join(directory, "document.tex");
    chapter = path.join(directory, "chapter.tex");
    figure = path.join(directory, "generated.pdf");
    image = path.join(directory, "image.png");
    bibliography = path.join(directory, "references.bib");
    fs.writeFileSync(source, "\\documentclass{article}\n\\input{chapter}\n");
    fs.writeFileSync(chapter, "Initial chapter\n");
    for (const filePath of [figure, image, bibliography])
      fs.writeFileSync(filePath, "initial input");
    fs.writeFileSync(
      source.replace(/\.tex$/, ".fls"),
      `INPUT ${source}\nINPUT ${chapter}\nINPUT ${figure}\nOUTPUT ${figure}\nINPUT ${image}\nINPUT ${bibliography}\n`,
    );
    lumine.project.setPaths([directory]);
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    service = main.buildService;
    leases = [];
    children = [];
    const nativeSpawn = childProcess.spawn;
    spyOn(childProcess, "spawn").and.callFake((command, ...args) => {
      if (command !== "latexmk") return nativeSpawn.call(childProcess, command, ...args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jasmine
        .createSpy("stop compiler")
        .and.callFake((signal) => child.emit("close", null, signal));
      children.push(child);
      return child;
    });
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("latex-tools");
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-observed-inputs-")
    )
      throw new Error("Unsafe observed input fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("supplies compiler inputs for diagnostics without expanding automatic observation", () => {
    const provider = service.providers.get("latex-tools").provider;
    expect(provider.getObservedPaths).toBeUndefined();
    expect(provider.getWatchPaths).toBeUndefined();
    expect(provider.getDiagnosticPaths(source)).toEqual([
      source,
      chapter,
      figure,
      image,
      bibliography,
    ]);
  });

  it("builds only changed root content and ignores chapter and other dependency changes", async () => {
    const watched = [];
    const nativeWatch = lumine.fileWatchClient.watchFile.bind(lumine.fileWatchClient);
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath, ...args) => {
      const file = nativeWatch(filePath, ...args);
      watched.push({ filePath, file });
      return file;
    });
    const provider = main.providePdfBuildProvider();
    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(watched.map(({ filePath }) => filePath)).toEqual([source]);
    await Promise.all(watched.map(({ file }) => file.ready));

    const dependencies = [chapter, figure, image, bibliography].map((filePath) => {
      const file = nativeWatch(filePath);
      const observed = { filePath, file, changes: 0 };
      leases.push(
        file,
        file.onDidChange(() => observed.changes++),
      );
      return observed;
    });
    await Promise.all(dependencies.map(({ file }) => file.ready));
    const changeDependencies = async (revision) => {
      const before = dependencies.map(({ changes }) => changes);
      for (const { filePath } of dependencies) fs.appendFileSync(filePath, revision);
      await conditionPromise(
        () => dependencies.every((dependency, index) => dependency.changes > before[index]),
        "the dependency changes to arrive",
      );
      await timeoutPromise(250);
    };
    await changeDependencies("updated before compilation\n");
    expect(children.length).toBe(0);
    expect(service.getJobs({ providerId: "latex-tools" })).toEqual([]);

    fs.appendFileSync(source, "% Externally generated source revision\n");
    await conditionPromise(() => children.length === 1, "the external TeX edit to compile");
    const first = service.getJob({ providerId: "latex-tools", filePath: source });
    expect(first.reason).toBe("save");
    await changeDependencies("updated during compilation\n");
    children[0].emit("close", 0, null);
    await first.completion;
    await timeoutPromise(250);
    expect(children.length).toBe(1);
    expect(service.getJobs({ providerId: "latex-tools" })).toEqual([first]);
    expect(first.state).toBe("passed");
    expect(main.getDiagnosticPaths(source)).toContain(figure);

    await changeDependencies("updated after compilation\n");
    expect(children.length).toBe(1);
    expect(service.getJobs({ providerId: "latex-tools" })).toEqual([first]);

    fs.appendFileSync(source, "% Another external root revision\n");
    await conditionPromise(() => children.length === 2, "the next root revision to compile");
    const second = service.getJob({ providerId: "latex-tools", filePath: source });
    expect(second).not.toBe(first);
    expect(second.reason).toBe("save");
    children[1].emit("close", 0, null);
    await second.completion;
    expect(second.state).toBe("passed");
    expect(service.getJobs({ providerId: "latex-tools" })).toEqual([first, second]);
  });

  it("does not rerun when a split source write restores the same bytes across completion", async () => {
    let sourceWatch;
    const nativeWatch = lumine.fileWatchClient.watchFile.bind(lumine.fileWatchClient);
    spyOn(lumine.fileWatchClient, "watchFile").and.callFake((filePath, ...args) => {
      const file = nativeWatch(filePath, ...args);
      if (filePath === source && !sourceWatch) sourceWatch = file;
      return file;
    });
    expect(main.setCompileOnSaveForFile(source, true)).toBeTrue();
    const entry = [...service.observed.values()].find((item) => item.filePath === source);
    await entry.observation.ready;
    await entry.observation.hasChanges();
    const original = fs.readFileSync(source);
    const first = main.runCompilation(source);
    await conditionPromise(() => children.length === 1, "the manual compilation to start");

    let deadline;
    let intermediateSeen = false;
    const intermediate = new Promise((resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error("The native watcher did not observe the truncated source")),
        1000,
      );
      leases.push(
        sourceWatch.onDidChange(() => {
          if (intermediateSeen || fs.statSync(source).size !== 0) return;
          intermediateSeen = true;
          clearTimeout(deadline);
          children[0].emit("close", 0, null);
          resolve();
        }),
      );
    });
    try {
      fs.truncateSync(source, 0);
      await intermediate;
      // Restore within the observation's quiet interval, after a real native
      // event has delivered the intermediate file and the compiler has exited.
      await timeoutPromise(40);
    } finally {
      clearTimeout(deadline);
      fs.writeFileSync(source, original);
    }
    await first.completion;
    await entry.observation.hasChanges();
    await timeoutPromise(250);
    expect(intermediateSeen).toBeTrue();
    expect(fs.readFileSync(source)).toEqual(original);
    expect(children.length).toBe(1);
    expect(service.getJobs({ providerId: "latex-tools" })).toEqual([first]);
    expect(first.state).toBe("passed");

    fs.appendFileSync(source, "% A meaningful root edit after the split write\n");
    await conditionPromise(() => children.length === 2, "the changed root to compile");
    const second = service.getJob({ providerId: "latex-tools", filePath: source });
    expect(second.reason).toBe("save");
    children[1].emit("close", 0, null);
    await second.completion;
    expect(second.state).toBe("passed");
    expect(service.getJobs({ providerId: "latex-tools" })).toEqual([first, second]);
  });
});
