const path = require("path");
const { Emitter } = require("lumine");

describe("latex-tools PDF opening notifications", () => {
  let mainModule, service, notification, sourcePath, pdfPath, emitter;
  const finish = (filePath, state = "passed") =>
    emitter.emit("finish", { providerId: "latex-tools", filePath, state });

  beforeEach(async () => {
    await lumine.packages.activatePackage("tasks");
    const pack = await lumine.packages.activatePackage("latex-tools");
    mainModule = pack.mainModule;
    service = mainModule.buildService;
    emitter = new Emitter();
    spyOn(service, "onDidFinishJob").and.callFake((callback) => emitter.on("finish", callback));
    sourcePath = path.resolve("document.tex");
    pdfPath = path.resolve("document.pdf");
    notification = { dismiss: jasmine.createSpy("dismiss") };
    spyOn(lumine.notifications, "addInfo").and.returnValue(notification);
    spyOn(lumine.notifications, "addWarning");
    spyOn(lumine.notifications, "addError");
    spyOn(mainModule, "_openPdfDirect");
    spyOn(mainModule, "_openPdfExternalDirect");
  });

  afterEach(async () => {
    mainModule.clearPendingPdfOpens();
    emitter.dispose();
    await lumine.packages.deactivatePackage("latex-tools");
  });

  it("keeps one wait and opens once after the matching build succeeds", () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);

    finish(path.resolve("other.tex"));
    advanceClock(100);
    expect(notification.dismiss).not.toHaveBeenCalled();
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();

    finish(sourcePath);
    expect(notification.dismiss).toHaveBeenCalled();
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(pdfPath, {}, sourcePath);
    finish(sourcePath);
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledTimes(1);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("uses the latest requested destination without adding another wait", () => {
    const externalPath = path.resolve("external.pdf");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, externalPath, true);
    finish(sourcePath);
    advanceClock(100);

    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).toHaveBeenCalledOnceWith(externalPath);
  });

  it("waits for a newer build instead of opening the previous build's output", () => {
    const externalPath = path.resolve("external.pdf");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath);
    mainModule.waitForBuildAndOpen(sourcePath, externalPath, true);
    advanceClock(100);

    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(1);

    finish(sourcePath);
    advanceClock(100);
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).toHaveBeenCalledOnceWith(externalPath);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("does not open stale output when a newer build fails during the open delay", () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath, "failed");
    advanceClock(100);

    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  for (const reason of ["Compiler error", "Build interrupted by user"]) {
    it(`clears the wait without another warning after ${reason.toLowerCase()}`, () => {
      mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
      finish(sourcePath, "failed");
      expect(notification.dismiss).toHaveBeenCalled();
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
      expect(lumine.notifications.addError).not.toHaveBeenCalled();
      expect(mainModule.pendingPdfOpens.size).toBe(0);

      finish(sourcePath);
      advanceClock(100);
      expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    });
  }

  it("dismisses pending waits when deactivated", async () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    await lumine.packages.deactivatePackage("latex-tools");
    expect(notification.dismiss).toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("cancels a delayed open when deactivated after the build finishes", async () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    finish(sourcePath);
    await lumine.packages.deactivatePackage("latex-tools");
    advanceClock(100);
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("opens internal and external PDFs silently and keeps open errors", async () => {
    mainModule._openPdfDirect.and.callThrough();
    mainModule._openPdfExternalDirect.and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    mainModule.openExternalService = {
      openExternal: jasmine.createSpy("openExternal").and.resolveTo(),
    };

    await mainModule._openPdfDirect(pdfPath);
    await mainModule._openPdfExternalDirect(pdfPath);
    expect(lumine.notifications.addInfo).not.toHaveBeenCalled();

    open.and.rejectWith(new Error("Cannot read PDF"));
    await mainModule._openPdfDirect(pdfPath);
    expect(lumine.notifications.addError).toHaveBeenCalledWith("Failed to open PDF", {
      detail: "Cannot read PDF",
      dismissable: true,
    });

    mainModule.openExternalService.openExternal.and.rejectWith(new Error("Cannot launch viewer"));
    await mainModule._openPdfExternalDirect(pdfPath);
    expect(lumine.notifications.addError).toHaveBeenCalledWith("Failed to open PDF externally", {
      detail: "Cannot launch viewer",
      dismissable: true,
    });
  });

  it("associates an explicit source before opening its PDF without requiring a previous job", async () => {
    const outputPath = path.resolve("published.pdf");
    const associate = spyOn(service, "associateArtifact").and.returnValue(true);
    expect(service.getJob({ providerId: "latex-tools", filePath: sourcePath })).toBeNull();
    mainModule._openPdfDirect.and.callThrough();
    const open = spyOn(lumine.workspace, "open").and.callFake(() => {
      expect(associate).toHaveBeenCalledOnceWith(
        { providerId: "latex-tools", filePath: sourcePath },
        outputPath,
      );
      return Promise.resolve({});
    });

    await mainModule._openPdfDirect(outputPath, { split: "right" }, sourcePath);

    expect(open).toHaveBeenCalledOnceWith(outputPath, { searchAllPanes: true, split: "right" });
  });
});
