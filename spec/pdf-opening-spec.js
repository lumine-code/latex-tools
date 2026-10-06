const path = require("path");

describe("latex-tools PDF opening notifications", () => {
  let mainModule, service, notification, sourcePath, pdfPath;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("latex-tools");
    mainModule = pack.mainModule;
    service = mainModule.provideLatexTools();
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
    await lumine.packages.deactivatePackage("latex-tools");
  });

  it("keeps one wait and opens once after the matching build succeeds", () => {
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);

    service.finishBuild(path.resolve("other.tex"), "", 1);
    advanceClock(100);
    expect(notification.dismiss).not.toHaveBeenCalled();
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();

    service.finishBuild(sourcePath, "", 1);
    expect(notification.dismiss).toHaveBeenCalled();
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledOnceWith(pdfPath);
    service.finishBuild(sourcePath, "", 1);
    advanceClock(100);
    expect(mainModule._openPdfDirect).toHaveBeenCalledTimes(1);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("uses the latest requested destination without adding another wait", () => {
    const externalPath = path.resolve("external.pdf");
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    mainModule.waitForBuildAndOpen(sourcePath, externalPath, true);
    service.finishBuild(sourcePath, "", 1);
    advanceClock(100);

    expect(lumine.notifications.addInfo).toHaveBeenCalledTimes(1);
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).toHaveBeenCalledOnceWith(externalPath);
  });

  it("waits for a newer build instead of opening the previous build's output", () => {
    const externalPath = path.resolve("external.pdf");
    service.startBuild(sourcePath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    service.finishBuild(sourcePath, "", 1);
    service.startBuild(sourcePath);
    mainModule.waitForBuildAndOpen(sourcePath, externalPath, true);
    advanceClock(100);

    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(1);

    service.finishBuild(sourcePath, "", 1);
    advanceClock(100);
    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).toHaveBeenCalledOnceWith(externalPath);
    expect(mainModule.pendingPdfOpens.size).toBe(0);
  });

  it("does not open stale output when a newer build fails during the open delay", () => {
    service.startBuild(sourcePath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    service.finishBuild(sourcePath, "", 1);
    service.startBuild(sourcePath);
    mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
    service.failBuild(sourcePath, "Compiler error", "");
    advanceClock(100);

    expect(mainModule._openPdfDirect).not.toHaveBeenCalled();
    expect(mainModule._openPdfExternalDirect).not.toHaveBeenCalled();
    expect(mainModule.pendingPdfOpens.size).toBe(0);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  for (const reason of ["Compiler error", "Build interrupted by user"]) {
    it(`clears the wait without another warning after ${reason.toLowerCase()}`, () => {
      mainModule.waitForBuildAndOpen(sourcePath, pdfPath);
      service.failBuild(sourcePath, reason, "");
      expect(notification.dismiss).toHaveBeenCalled();
      expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
      expect(lumine.notifications.addError).not.toHaveBeenCalled();
      expect(mainModule.pendingPdfOpens.size).toBe(0);

      service.finishBuild(sourcePath, "", 1);
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
    service.finishBuild(sourcePath, "", 1);
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
});
