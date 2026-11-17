const fs = require("node:fs");
const promises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Disposable } = require("lumine");

describe("LaTeX execution actions", () => {
  let main, service, taskProvider, directory, source, pdf, previousPaths, leases;
  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-task-actions-")));
    source = path.join(directory, "document.tex");
    pdf = path.join(directory, "document.pdf");
    fs.writeFileSync(source, "\\documentclass{article}\n");
    lumine.project.setPaths([directory]);
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    service = main.buildService;
    taskProvider = service.providers.get("latex-tools").provider;
    leases = [];
  });
  afterEach(async () => {
    for (const lease of leases.reverse()) lease.dispose();
    await lumine.packages.deactivatePackage("latex-tools");
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-task-actions-")
    )
      throw new Error("Unsafe task action fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function execution(overrides = {}) {
    return {
      job: { state: "collecting" },
      filePath: source,
      code: 0,
      signal: null,
      error: null,
      plan: {
        cwd: directory,
        artifacts: [{ path: pdf, kind: "pdf", sourcePath: source }],
        diagnosticSnapshot: require("../lib/latex-target").snapshotDiagnostics(source),
      },
      ...overrides,
    };
  }
  async function collected(overrides, provider = taskProvider) {
    const result = execution(overrides);
    const output = await provider.collectResult(result, new AbortController().signal);
    result.job.state = "passed";
    return { result, output, action: output.actions[0] };
  }
  function anotherService() {
    const alternate = new service.constructor();
    leases.push(new Disposable(() => alternate.dispose()));
    const edge = main.consumeTasks(alternate);
    leases.push(edge);
    return { alternate, edge };
  }
  async function holdPdfStat() {
    const nativeStat = promises.stat;
    const stat = await nativeStat(pdf);
    let release, entered;
    const started = new Promise((resolve) => (entered = resolve));
    const pending = new Promise((resolve) => (release = () => resolve(stat)));
    spyOn(promises, "stat").and.callFake((filePath, ...args) => {
      if (filePath !== pdf) return nativeStat(filePath, ...args);
      entered();
      return pending;
    });
    leases.push(new Disposable(release));
    return { started, release };
  }

  it("offers an unchanged existing declared PDF and opens its captured custom path and source", async () => {
    const outputDirectory = path.join(directory, "output");
    fs.mkdirSync(outputDirectory);
    const outputPath = path.join(outputDirectory, "published.pdf");
    fs.writeFileSync(outputPath, "%PDF-1.7\nOwned compiled output\n");
    const before = fs.statSync(outputPath).mtimeMs;
    const { result, action } = await collected({
      plan: { cwd: directory, artifacts: [{ path: "output/published.pdf", kind: "pdf" }] },
    });
    expect(action.id).toBe("open-pdf");
    expect(action.label).toBe("Open PDF");
    expect(fs.statSync(outputPath).mtimeMs).toBe(before);
    const association = spyOn(service, "associateArtifact").and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.callFake(() => {
      expect(association).toHaveBeenCalledOnceWith(
        { providerId: "latex-tools", filePath: source },
        outputPath,
      );
      return Promise.resolve({});
    });
    spyOn(main, "getRootFilePath").and.throwError("The action must not rediscover a root");
    spyOn(main, "commandDocument").and.throwError("The action must not borrow document focus");
    const controller = new AbortController();

    expect(await action.run(result.job, controller.signal)).toBeTrue();

    expect(open).toHaveBeenCalledOnceWith(outputPath, {
      searchAllPanes: true,
      signal: controller.signal,
    });
  });

  for (const kind of ["missing", "empty", "directory"]) {
    it(`does not offer a ${kind} PDF output`, async () => {
      if (kind === "empty") fs.writeFileSync(pdf, "");
      if (kind === "directory") fs.mkdirSync(pdf);
      expect((await collected()).output.actions).toEqual([]);
    });
  }

  it("does not infer a PDF when the execution declares another artifact kind", async () => {
    fs.writeFileSync(pdf, "previous output");
    const { output } = await collected({
      plan: { cwd: directory, artifacts: [{ path: "document.png", kind: "png" }] },
    });
    expect(output.actions).toEqual([]);
  });

  for (const [reason, overrides] of [
    ["compiler failure", { code: 12 }],
    ["launcher failure", { error: new Error("Cannot launch latexmk") }],
    ["termination", { signal: "SIGTERM" }],
    ["semantic failure", { failed: true }],
    ["failed result state", { job: { state: "collecting", resultFailed: true } }],
  ]) {
    it(`does not offer an old PDF after ${reason}`, async () => {
      fs.writeFileSync(pdf, "previous compiled output");
      expect((await collected(overrides)).output.actions).toEqual([]);
    });
  }

  it("declines another execution or a result that is not successful", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const { result, action } = await collected();
    const open = spyOn(lumine.workspace, "open");
    expect(await action.run({ state: "passed" }, new AbortController().signal)).toBeFalse();
    result.job.state = "failed";
    expect(await action.run(result.job, new AbortController().signal)).toBeFalse();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a removed or emptied output to Tasks without its own duplicate notification", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const { result, action } = await collected();
    const open = spyOn(lumine.workspace, "open");
    const notify = spyOn(lumine.notifications, "addError");
    fs.unlinkSync(pdf);
    await expectAsync(action.run(result.job, new AbortController().signal)).toBeRejectedWithError(
      /Unable to read compiled PDF/,
    );
    fs.writeFileSync(pdf, "");
    await expectAsync(action.run(result.job, new AbortController().signal)).toBeRejectedWithError(
      /Compiled PDF is unavailable or empty/,
    );
    expect(open).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("propagates an opener failure with the output path and no duplicate notification", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const { result, action } = await collected();
    spyOn(lumine.workspace, "open").and.rejectWith(new Error("Owned opener failure"));
    const notify = spyOn(lumine.notifications, "addError");
    await expectAsync(action.run(result.job, new AbortController().signal)).toBeRejectedWithError(
      /Unable to open compiled PDF.*Owned opener failure/,
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("honors cancellation while collecting the PDF action", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const held = await holdPdfStat();
    const controller = new AbortController();
    const collecting = taskProvider.collectResult(execution(), controller.signal);
    await held.started;
    controller.abort();
    held.release();
    await expectAsync(collecting).toBeRejected();
  });

  it("honors the action lifetime while its file is being checked", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const { result, action } = await collected();
    const held = await holdPdfStat();
    const controller = new AbortController();
    const open = spyOn(lumine.workspace, "open");
    const running = action.run(result.job, controller.signal);
    await held.started;
    controller.abort();
    held.release();
    await expectAsync(running).toBeRejected();
    expect(await action.run(result.job, controller.signal)).toBeFalse();
    expect(open).not.toHaveBeenCalled();
  });

  for (const withdrawal of ["provider", "backend"]) {
    it(`keeps a pending action inert after its ${withdrawal} retires`, async () => {
      fs.writeFileSync(pdf, "compiled output");
      const { result, action } = await collected();
      const held = await holdPdfStat();
      const open = spyOn(lumine.workspace, "open");
      const running = action.run(result.job, new AbortController().signal);
      await held.started;
      if (withdrawal === "provider") {
        await lumine.packages.deactivatePackage("latex-tools");
        main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
      } else {
        await lumine.packages.deactivatePackage("tasks");
      }
      held.release();
      expect(await running).toBeFalse();
      expect(open).not.toHaveBeenCalled();
    });
  }

  it("checks cancellation again after associating the artifact and before opening it", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const { result, action } = await collected();
    const controller = new AbortController();
    spyOn(service, "associateArtifact").and.callFake(() => controller.abort());
    const open = spyOn(lumine.workspace, "open");
    await expectAsync(action.run(result.job, controller.signal)).toBeRejected();
    expect(open).not.toHaveBeenCalled();
  });

  it("retains the originating task service when another backend becomes preferred during collection", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const held = await holdPdfStat();
    const result = execution();
    const collecting = taskProvider.collectResult(result, new AbortController().signal);
    await held.started;
    const { alternate } = anotherService();
    expect(main.buildService).toBe(alternate);
    held.release();
    const { actions } = await collecting;
    result.job.state = "passed";
    const originalAssociation = spyOn(service, "associateArtifact").and.callThrough();
    const otherAssociation = spyOn(alternate, "associateArtifact").and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});

    expect(await actions[0].run(result.job, new AbortController().signal)).toBeTrue();

    expect(originalAssociation).toHaveBeenCalledOnceWith(
      { providerId: "latex-tools", filePath: source },
      pdf,
    );
    expect(otherAssociation).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps an action available until the last edge for its originating service leaves", async () => {
    fs.writeFileSync(pdf, "compiled output");
    const { alternate, edge } = anotherService();
    const second = main.consumeTasks(alternate);
    leases.push(second);
    const alternateProvider = alternate.providers.get("latex-tools").provider;
    const { result, action } = await collected(undefined, alternateProvider);
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    edge.dispose();

    expect(await action.run(result.job, new AbortController().signal)).toBeTrue();

    second.dispose();
    expect(main.buildService).toBe(service);
    expect(await action.run(result.job, new AbortController().signal)).toBeFalse();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
