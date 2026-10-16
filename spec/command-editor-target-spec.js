const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
describe("LaTeX Tools document command targets", () => {
  let main, directory, first, second;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "latex-owned-command-")));
    for (const name of ["first", "second"]) {
      await fs.writeFile(path.join(directory, name + ".tex"), "Original " + name);
      await fs.writeFile(path.join(directory, name + ".pdf"), "Owned inert PDF bytes");
    }
    first = await lumine.workspace.open(path.join(directory, "first.tex"));
    const firstPane = lumine.workspace.paneForItem(first);
    firstPane.splitRight();
    second = await lumine.workspace.open(path.join(directory, "second.tex"));
    firstPane.activate();
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    main.consumeOpenExternal({ openExternal: async () => {} });
    spyOn(main, "runCompilation").and.stub();
    spyOn(main, "cleanFile").and.resolveTo();
    spyOn(main, "killProcess").and.stub();
    spyOn(main, "_openPdfDirect").and.resolveTo();
    spyOn(main, "_openPdfExternalDirect").and.resolveTo();
    spyOn(main, "syncToPdf").and.resolveTo(null);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("latex-tools");
    first?.destroy();
    second?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(await fs.realpath(directory)) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(directory).startsWith("latex-owned-command-")
    )
      throw Error("Unsafe fixture cleanup");
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  for (const command of [
    "compile",
    "open-pdf",
    "open-pdf-external",
    "clean",
    "interrupt",
    "kill-and-clean",
    "toggle-compile-on-save",
    "synctex",
  ]) {
    it(`applies ${command} to its inactive split editor`, async () => {
      const target = second.getPath();
      expect(lumine.workspace.getActiveTextEditor()).toBe(first);
      if (command === "compile") {
        first.setText("Changed first");
        second.setText("Changed second");
      }
      if (command === "interrupt" || command === "kill-and-clean") {
        main.buildProcesses.set(first.getPath(), { process: { label: "first" } });
        main.buildProcesses.set(target, { process: { label: "second" } });
      }
      await lumine.commands.dispatch(second.getElement(), "latex-tools:" + command);
      if (command === "compile") {
        expect(main.runCompilation).toHaveBeenCalledOnceWith(target);
        expect(await fs.readFile(target, "utf8")).toBe("Changed second");
        expect(await fs.readFile(first.getPath(), "utf8")).toBe("Original first");
      } else if (command === "open-pdf")
        expect(main._openPdfDirect).toHaveBeenCalledOnceWith(target.replace(/\.tex$/, ".pdf"));
      else if (command === "open-pdf-external")
        expect(main._openPdfExternalDirect).toHaveBeenCalledOnceWith(
          target.replace(/\.tex$/, ".pdf"),
        );
      else if (command === "clean" || command === "kill-and-clean")
        expect(main.cleanFile).toHaveBeenCalledOnceWith(target);
      else if (command === "interrupt")
        expect(main.killProcess).toHaveBeenCalledOnceWith({ label: "second" });
      else if (command === "toggle-compile-on-save") {
        expect(main.isCompileOnSaveEnabledForFile(target)).toBe(true);
        expect(main.isCompileOnSaveEnabledForFile(first.getPath())).toBe(false);
      } else expect(main.syncToPdf).toHaveBeenCalledOnceWith(target, 1, 1);
    });
  }
  it("keeps workspace compilation using the active editor", async () => {
    await lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "latex-tools:compile");
    expect(main.runCompilation).toHaveBeenCalledOnceWith(first.getPath());
  });
});
