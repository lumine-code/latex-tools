const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

describe("latex-tools status menus", () => {
  let main, directory, editor, tile, counter, tooltipCalls;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    tooltipCalls = spyOn(lumine.tooltips, "add").and.callThrough();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "latex-tools-status-")));
    await fs.writeFile(path.join(directory, "document.tex"), "source");
    editor = await lumine.workspace.open(path.join(directory, "document.tex"));
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    main.ensureStatusBarViews();
    tile = main.statusBarView.getElement();
    counter = main.observedFilesStatusView.getElement();
    lumine.workspace.getElement().append(tile, counter);
    spyOn(main, "runCompilation").and.returnValue(true);
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("latex-tools");
    editor?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(await fs.realpath(directory)) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(directory).startsWith("latex-tools-status-")
    )
      throw Error("Unsafe status fixture cleanup");
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function menu(element = tile) {
    return lumine.contextMenu.templateForElement(element);
  }
  it("lists every mouse action and reads observation state when opened", () => {
    const before = menu();
    expect(before.filter((item) => item.command).map((item) => item.command)).toEqual([
      "latex-tools:compile",
      "latex-tools:toggle-compile-on-save",
      "latex-tools:split-pdf-source",
      "latex-tools:kill-and-clean",
    ]);
    expect(
      before.find((item) => item.command === "latex-tools:toggle-compile-on-save").checked,
    ).toBe(false);
    spyOn(main, "isCompileOnSaveEnabledForFile").and.returnValue(true);
    expect(
      menu(tile.firstChild).find((item) => item.command === "latex-tools:toggle-compile-on-save")
        .checked,
    ).toBe(true);
    expect(main.runCompilation).not.toHaveBeenCalled();
    expect(
      menu()
        .filter((item) => item.mouseBindingLabel)
        .map((item) => item.mouseBindingLabel),
    ).toEqual(["LMB", "Alt+LMB", "MMB"]);
    expect(
      menu(counter).find((item) => item.command === "latex-tools:observed-files").mouseBindingLabel,
    ).toBe("LMB");
    const options = tooltipCalls.calls.all().find((call) => call.args[0] === tile).args[1];
    expect(options.keyBindingCommand).toBe("latex-tools:compile");
    expect(options.keyBindingTarget()).toBe(editor.getElement());
    expect(options.html).toBe(false);
    expect(options.keyBindingExtra).toBeUndefined();
    expect(options.title()).toBe("Idle. Compile this document.");
    main.statusBarView.setStatus("building");
    expect(options.title()).toBe("Building. Compile this document.");
    const counterOptions = tooltipCalls.calls.all().find((call) => call.args[0] === counter)
      .args[1];
    expect(counterOptions.keyBindingCommand).toBe("latex-tools:observed-files");
    expect(counterOptions.keyBindingTarget).toBe(counter);
    expect(counterOptions.keyBindingExtra).toBeUndefined();
    main.observedFilesStatusView.setCount(2);
    expect(counterOptions.title()).toBe("2 observed files. Open the list.");
  });
  it("resolves the primary keyboard hint from the tile's current editor", async () => {
    const options = tooltipCalls.calls.all().find((call) => call.args[0] === tile).args[1];
    const other = await lumine.workspace.open();
    expect(options.keyBindingTarget()).toBe(other.getElement());
    spyOn(lumine.workspace, "resolveCommandContext").and.returnValue({ embeddedEditor: null });
    expect(options.keyBindingTarget()).toBeNull();
    other.destroy();
  });
  it("opens right-click menus without executing or blocking an action", () => {
    const stop = spyOn(main, "killAndCleanFromStatusBar");
    const clear = spyOn(main, "clearCompileOnSaveFiles");
    for (const element of [tile, counter]) {
      element.remove();
      element.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
      const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(main.runCompilation).not.toHaveBeenCalled();
    expect(
      menu(counter)
        .filter((item) => item.command)
        .map((item) => item.command),
    ).toEqual(["latex-tools:observed-files", "latex-tools:clear-all-observed-files"]);
  });
  it("uses the same split command for middle click and the menu", async () => {
    const open = spyOn(main, "openPdfFromStatusBar");
    tile.dispatchEvent(new MouseEvent("mousedown", { button: 1, bubbles: true }));
    expect(open.calls.count()).toBe(1);
    expect(open.calls.mostRecent().args[0].context.embeddedEditor).toBe(editor);
    await lumine.commands.dispatch(tile, "latex-tools:split-pdf-source");
    expect(open.calls.count()).toBe(2);
    expect(open.calls.mostRecent().args[0].context.embeddedEditor).toBe(editor);
  });
  it("observes and compiles the PDF source without another active text editor", async () => {
    const context = {
      embeddedEditor: null,
      documentItem: { filePath: editor.getPath().replace(/\.tex$/, ".pdf") },
    };
    const event = { target: tile, context };
    const observe = spyOn(main, "setCompileOnSaveForFile").and.returnValue(true);
    main.toggleCompileOnSave(event);
    expect(observe.calls.mostRecent().args[0]).toBe(editor.getPath());
    expect(observe.calls.mostRecent().args[1]).toBe(true);
    await main.compileFromStatusBar(event);
    expect(main.runCompilation).toHaveBeenCalledOnceWith(editor.getPath());
  });
  it("captures the invoking window's editor before compiling", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const other = lumine.workspace.buildTextEditor();
    other.getBuffer().setPath(path.join(directory, "other.tex"));
    extra.getEditorContainer().getActivePane().activateItem(other, { activatePane: true });
    extra.getElement().append(tile);
    const compile = spyOn(main, "compile").and.resolveTo();
    await lumine.commands.dispatch(tile, "latex-tools:compile");
    expect(compile.calls.mostRecent().args[0].context.embeddedEditor).toBe(other);
  });
  it("uses the document's embedded editor from a tile command", async () => {
    const element = document.createElement("div");
    const embeddedItem = {
      getTitle: () => "Embedded source",
      getElement: () => element,
      getActiveEmbeddedTextEditor: () => editor,
    };
    lumine.workspace.getActivePane().activateItem(embeddedItem);
    const compile = spyOn(main, "compile").and.resolveTo();
    await lumine.commands.dispatch(tile, "latex-tools:compile");
    expect(compile.calls.mostRecent().args[0].context.embeddedEditor).toBe(editor);
    lumine.workspace.getActivePane().destroyItem(embeddedItem);
  });
  it("disposes runtime menu registrations when deactivated", async () => {
    await lumine.packages.deactivatePackage("latex-tools");
    const dispatch = spyOn(lumine.commands, "dispatch").and.resolveTo();
    tile.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    counter.click();
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      lumine.contextMenu.itemSets.some(
        (set) => set.selector === "status-bar-tile.latex-tools-status",
      ),
    ).toBe(false);
  });
});
