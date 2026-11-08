const fs = require("node:fs");
const promises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Disposable, Emitter } = require("lumine");
const manifest = require("../package.json");

describe("LaTeX PDF build provider", () => {
  let main, backend, provider, directory, source, pdf, leases;

  async function holdSourceInspection() {
    const nativeStat = promises.stat;
    const stats = await nativeStat.call(promises, source);
    let finish, entered;
    const pending = new Promise((resolve) => {
      finish = () => resolve(stats);
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    spyOn(promises, "stat").and.callFake((filePath, ...args) => {
      if (filePath !== source) return nativeStat.call(promises, filePath, ...args);
      entered();
      return pending;
    });
    leases.push(new Disposable(finish));
    return { started, finish };
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-pdf-provider-")));
    source = path.join(directory, "document.tex");
    pdf = path.join(directory, "document.pdf");
    fs.writeFileSync(source, "\\documentclass{article}\n");
    fs.writeFileSync(pdf, "Owned inert PDF fixture");
    lumine.project.setPaths([directory]);
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    backend = main.buildService;
    provider = main.providePdfBuildProvider();
    leases = [];
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("latex-tools");
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-pdf-provider-")
    )
      throw new Error("Unsafe PDF provider fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("publishes its independent versioned PDF build provider", () => {
    expect(manifest.providedServices["pdf-view.build-provider"].versions).toEqual({
      "1.0.0": "providePdfBuildProvider",
    });
    const received = [];
    leases.push(
      lumine.packages.serviceHub.consume("pdf-view.build-provider", "^1.0.0", (value) => {
        if (value.id === "latex-tools") received.push(value);
        return new Disposable();
      }),
    );
    expect(received.length).toBe(1);
    expect(received[0].name).toBe("LaTeX");
    expect(Object.keys(received[0]).sort()).toEqual([
      "build",
      "canBuild",
      "canToggleCompileOnSave",
      "id",
      "isBuilding",
      "isCompileOnSaveEnabled",
      "name",
      "onDidChangeBuilds",
      "onDidChangeSources",
      "resolveSource",
      "toggleCompileOnSave",
    ]);
  });

  it("resolves an existing PDF with a closed source and no build history", async () => {
    expect(lumine.workspace.getTextEditors()).toEqual([]);
    expect(backend.getJobs({ providerId: "latex-tools" })).toEqual([]);
    expect(await provider.resolveSource(pdf)).toBe(source);
    expect(provider.canBuild(source)).toBeTrue();
    expect(backend.getArtifactTarget(pdf)).toBeNull();
  });

  it("prefers its explicit source association and declines another provider's association", async () => {
    const renamed = path.join(directory, "published.pdf");
    backend.associateArtifact({ providerId: "latex-tools", filePath: source }, renamed);
    expect(await provider.resolveSource(renamed)).toBe(source);
    leases.push(
      backend.registerProvider({
        id: "other-pdf-provider",
        name: "Other",
        supports: () => true,
        prepare: () => ({ cmd: "unused", args: [], cwd: directory }),
      }),
    );
    backend.associateArtifact({ providerId: "other-pdf-provider", filePath: source }, pdf);
    expect(await provider.resolveSource(pdf, { sourcePath: source })).toBeNull();
  });

  it("validates restored hints against the canonical root output", async () => {
    const chapter = path.join(directory, "chapter.tex");
    fs.writeFileSync(chapter, "% !TEX root = document.tex\nChapter\n");
    expect(await provider.resolveSource(pdf, { sourcePath: chapter })).toBe(source);
    expect(
      await provider.resolveSource(path.join(directory, "unrelated.pdf"), { sourcePath: chapter }),
    ).toBeNull();
    expect(await provider.resolveSource(path.join(directory, "chapter.pdf"))).toBeNull();
  });

  it("does not claim missing sources, directories or non-PDF documents", async () => {
    expect(await provider.resolveSource(path.join(directory, "missing.pdf"))).toBeNull();
    fs.mkdirSync(path.join(directory, "folder.tex"));
    expect(await provider.resolveSource(path.join(directory, "folder.pdf"))).toBeNull();
    expect(await provider.resolveSource(source)).toBeNull();
  });

  it("keeps availability and concurrent output-writing queries free of source discovery", () => {
    const jobs = [
      { state: "running", artifacts: [{ path: pdf, kind: "pdf" }] },
      { state: "collecting", artifacts: [{ path: pdf, kind: "pdf" }] },
    ];
    const latest = spyOn(backend, "getJob").and.returnValue(null);
    spyOn(backend, "getJobs").and.callFake(() => jobs);
    spyOn(backend, "getObserved").and.returnValue([
      { providerId: "latex-tools", filePath: source },
    ]);
    const root = spyOn(main, "getRootFilePath").and.throwError("Unexpected root discovery");
    const stat = spyOn(promises, "stat").and.throwError("Unexpected filesystem query");
    expect(provider.canBuild(source)).toBeTrue();
    expect(provider.canBuild(pdf)).toBeFalse();
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeTrue();
    expect(provider.canToggleCompileOnSave(pdf)).toBeFalse();
    expect(provider.canToggleCompileOnSave("relative.tex")).toBeFalse();
    expect(provider.isCompileOnSaveEnabled(pdf)).toBeFalse();
    expect(provider.isBuilding(pdf)).toBeTrue();
    jobs.shift();
    expect(provider.isBuilding(pdf)).toBeTrue();
    jobs.shift();
    expect(provider.isBuilding(pdf)).toBeFalse();
    latest.and.returnValue({ state: "preparing" });
    expect(provider.canBuild(source)).toBeFalse();
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeTrue();
    expect(root).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("toggles compile-on-save for a closed source without compiling or opening Tasks", async () => {
    const build = (await lumine.packages.activatePackage("tasks")).mainModule;
    const ensurePanel = spyOn(build, "ensurePanel").and.callThrough();
    const run = spyOn(backend, "run").and.returnValue(null);
    const success = spyOn(lumine.notifications, "addSuccess");
    const info = spyOn(lumine.notifications, "addInfo");
    const changes = jasmine.createSpy("observed state changed");
    leases.push(provider.onDidChangeBuilds(changes));
    expect(lumine.workspace.getTextEditors()).toEqual([]);
    expect(provider.canToggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();

    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeTrue();
    expect(backend.getObserved({ providerId: "latex-tools" })).toEqual([
      { providerId: "latex-tools", filePath: source },
    ]);
    expect(changes).toHaveBeenCalledTimes(1);

    expect(provider.toggleCompileOnSave(source)).toBeTrue();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(backend.getObserved({ providerId: "latex-tools" })).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(backend.getJobs({ providerId: "latex-tools" })).toEqual([]);
    expect(ensurePanel).not.toHaveBeenCalled();
    expect(build.panel).toBeNull();
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("routes a build through its own shared backend and becomes unavailable when it leaves", async () => {
    const job = { id: "owned-job" };
    const run = spyOn(main, "runCompilation").and.returnValue(job);
    expect(provider.build(source)).toBe(job);
    expect(run).toHaveBeenCalledOnceWith(source);
    await lumine.packages.deactivatePackage("tasks");
    expect(provider.canBuild(source)).toBeFalse();
    expect(provider.build(source)).toBeNull();
    expect(provider.isBuilding(pdf)).toBeFalse();
    expect(provider.canToggleCompileOnSave(source)).toBeFalse();
    expect(provider.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(provider.toggleCompileOnSave(source)).toBeFalse();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("publishes cached activity, source changes and backend edge changes", () => {
    const changes = new Emitter();
    let observedChanged;
    const builds = jasmine.createSpy("builds");
    const sources = jasmine.createSpy("sources");
    leases.push(changes, provider.onDidChangeBuilds(builds), provider.onDidChangeSources(sources));
    const edge = main.consumeTasks({
      registerProvider: () => new Disposable(),
      onDidChangeJob: (callback) => changes.on("job", callback),
      onDidChangeObserved: (callback) => {
        observedChanged = callback;
        return new Disposable();
      },
      onDidChangeArtifactTargets: (callback) => changes.on("source", callback),
      getObserved: () => [],
      getJobs: () => [],
    });
    leases.push(edge);
    expect(sources).toHaveBeenCalledOnceWith({});
    expect(builds).toHaveBeenCalledTimes(1);
    changes.emit("job", { providerId: "unrelated" });
    expect(builds).toHaveBeenCalledTimes(1);
    changes.emit("job", { providerId: "latex-tools" });
    expect(builds).toHaveBeenCalledTimes(2);
    changes.emit("source", { artifactPath: pdf });
    expect(sources).toHaveBeenCalledWith({ pdfPath: pdf });
    observedChanged({ providerId: "unrelated" });
    expect(builds).toHaveBeenCalledTimes(2);
    observedChanged({ providerId: "latex-tools" });
    expect(builds).toHaveBeenCalledTimes(3);
    edge.dispose();
    expect(sources.calls.mostRecent().args).toEqual([{}]);
    expect(builds).toHaveBeenCalledTimes(4);
    observedChanged({ providerId: "latex-tools" });
    expect(builds).toHaveBeenCalledTimes(4);
  });

  it("honors cancellation while resolving the source", async () => {
    const inspection = await holdSourceInspection();
    const controller = new AbortController();
    const resolving = provider.resolveSource(pdf, { signal: controller.signal });
    await inspection.started;
    controller.abort();
    inspection.finish();
    await expectAsync(resolving).toBeRejected();
  });

  it("discards a pending reply after the authoritative source changes", async () => {
    const inspection = await holdSourceInspection();
    const resolving = provider.resolveSource(pdf);
    await inspection.started;
    backend.associateArtifact({ providerId: "latex-tools", filePath: source }, pdf);
    inspection.finish();
    expect(await resolving).toBeNull();
  });

  it("keeps retired payloads and pending source replies inert after reactivation", async () => {
    const inspection = await holdSourceInspection();
    const resolving = provider.resolveSource(pdf);
    await inspection.started;
    const stale = provider;
    await lumine.packages.deactivatePackage("latex-tools");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    inspection.finish();
    expect(await resolving).toBeNull();
    expect(await stale.resolveSource(pdf)).toBeNull();
    expect(stale.canBuild(source)).toBeFalse();
    expect(stale.build(source)).toBeNull();
    expect(stale.isBuilding(pdf)).toBeFalse();
    expect(stale.canToggleCompileOnSave(source)).toBeFalse();
    expect(stale.isCompileOnSaveEnabled(source)).toBeFalse();
    expect(stale.toggleCompileOnSave(source)).toBeFalse();
    expect(main.buildService.getObserved({ providerId: "latex-tools" })).toEqual([]);
    const callback = jasmine.createSpy("retired callback");
    leases.push(stale.onDidChangeSources(callback), stale.onDidChangeBuilds(callback));
    main.buildService.associateArtifact({ providerId: "latex-tools", filePath: source }, pdf);
    expect(callback).not.toHaveBeenCalled();
  });
});
