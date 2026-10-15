const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { CompositeDisposable } = require("lumine");

describe("latex-tools observed file opening gestures", () => {
  let list, host, model, chooser, external, scratch, selectedPath, rootPath, items, leases;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    scratch = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "latex-tools-observed-gestures-")),
    );
    selectedPath = path.join(scratch, "second.tex");
    rootPath = path.join(scratch, "root.tex");
    const firstPath = path.join(scratch, "first.tex");
    for (const filePath of [firstPath, selectedPath, rootPath])
      fs.writeFileSync(filePath, "observed source\n");
    const pack = await lumine.packages.activatePackage("latex-tools");
    const currentRequire = createRequire(path.join(pack.path, "package.json"));
    const ObservedList = currentRequire("./lib/observed-list");
    list = new ObservedList(pack.mainModule);
    items = [firstPath, selectedPath].map((filePath) => ({
      filePath,
      displayPath: path.basename(filePath),
      rootPath,
      rootDisplayPath: path.basename(rootPath),
      outputDisplayPath: "output.pdf",
    }));
    spyOn(list, "buildItems").and.callFake(() => items);
    chooser = (await lumine.packages.activatePackage("launcher")).mainModule;
    external = (await lumine.packages.activatePackage("open-external")).mainModule;
    spyOn(lumine.shell, "openPath").and.resolveTo("");
    spyOn(lumine.shell, "showItemInFolder").and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    leases = new CompositeDisposable();
    host = list.selectListHost;
    model = list.selectList;
    await host.show();
    await model.selectItemById(items[0].filePath);
  });

  afterEach(async () => {
    leases.dispose();
    await list.destroy();
    await lumine.packages.deactivatePackage("launcher");
    await lumine.packages.deactivatePackage("open-external");
    await lumine.packages.deactivatePackage("latex-tools");
    for (const pane of lumine.workspace.getPanes()) {
      for (const item of [...pane.getItems()]) {
        const itemPath = item.getPath?.() ?? item.getURI?.();
        if (itemPath?.startsWith(scratch + path.sep)) await pane.destroyItem(item);
      }
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), scratch);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Observed fixture escaped its temporary root");
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function rowFor(filePath) {
    const index = model.getDisplayedItems().findIndex((item) => item.filePath === filePath);
    return model.getElement().querySelectorAll('[role="option"]')[index];
  }

  function nextAction() {
    return new Promise((resolve) => {
      const lease = model.onDidFinishAction((result) => {
        lease.dispose();
        resolve(result);
      });
    });
  }

  async function click(modifiers = {}) {
    const finished = nextAction();
    rowFor(selectedPath)
      .querySelector(".primary-line")
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...modifiers }),
      );
    const result = await finished;
    await flushMicrotasks();
    return result;
  }

  it("pushes Launcher for the clicked source file instead of its compile root", async () => {
    const result = await click({ altKey: true });
    expect(result.status).toBe("success");
    expect(result.command).toBe("latex-tools:open");
    const child = chooser.pickers.get(lumine.workspace.getMainWindow());
    expect(child.context.path).toBe(selectedPath);
    expect(child.context.path).not.toBe(rootPath);
    expect(child.context.window).toBe(host.window);
    expect(child.host.isVisible()).toBe(true);
    expect(host.isVisible()).toBe(false);
    expect(lumine.workspace.getModalTrail()).toEqual(["Observed Files", "Open"]);
    expect(lumine.workspace.popModal()).toBe(true);
    await child.host.destroy();
    expect(host.isVisible()).toBe(true);
    expect(model.getSelectedItem().filePath).toBe(selectedPath);
  });

  it("opens the selected observed file through Alt-Enter", async () => {
    await model.selectItemById(selectedPath);
    const finished = nextAction();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: model.getQueryEditor().getElement() });
    lumine.keymaps.handleKeyboardEvent(event);
    const result = await finished;
    expect(result.command).toBe("latex-tools:open");
    expect(chooser.pickers.get(host.window).context.path).toBe(selectedPath);
  });

  for (const pending of [false, true])
    it("keeps ordinary clicks on the default opener with previews " + pending, async () => {
      lumine.config.set("core.allowPendingPaneItems", pending);
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const result = await click();
      expect(result.command).toBe("latex-tools:open-selected-file");
      expect(open.calls.mostRecent().args[0]).toBe(selectedPath);
      expect(open.calls.mostRecent().args[1].pending).toBe(pending);
      const editor = await open.calls.mostRecent().returnValue;
      expect(editor.getText()).toBe("observed source\n");
      expect(lumine.workspace.paneForItem(editor).getPendingItem() === editor).toBe(pending);
    });

  for (const [modifiers, method, command] of [
    [{ ctrlKey: true, altKey: true }, "openExternal", "open-external"],
    [{ altKey: true, shiftKey: true }, "showInFolder", "show-in-folder"],
  ])
    it("runs " + command + " exactly once for the clicked source file", async () => {
      const action = spyOn(external, method).and.resolveTo("");
      const result = await click(modifiers);
      expect(result.status).toBe("success");
      expect(result.command).toBe("latex-tools:" + command);
      expect(action).toHaveBeenCalledOnceWith(selectedPath);
      expect(lumine.workspace.getPaneItems()).toEqual([]);
      expect(lumine.application.openWindow).not.toHaveBeenCalled();
    });

  it("retains native error state and the picker when a system action fails", async () => {
    spyOn(external, "showInFolder").and.rejectWith(new Error("Reveal failed"));
    const result = await click({ altKey: true, shiftKey: true });
    expect(result.status).toBe("error");
    expect(model.getStatus()).toEqual({ type: "error", message: "Reveal failed" });
    expect(host.isVisible()).toBe(true);
  });

  it("removes row modifier handlers when filtering retires the row", async () => {
    const retired = rowFor(selectedPath);
    await model.setQuery("first");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      altKey: true,
    });
    retired.querySelector(".primary-line").dispatchEvent(event);
    await flushMicrotasks();
    expect(event.defaultPrevented).toBe(false);
    expect(chooser.pickers.size).toBe(0);
  });

  it("binds the standard local Enter variants and advertises no F12 aliases", () => {
    const input = model.getQueryEditor().getElement();
    for (const [key, command] of [
      ["alt-enter", "open"],
      ["ctrl-alt-enter", "open-external"],
      ["alt-shift-enter", "show-in-folder"],
    ])
      expect(lumine.keymaps.findKeyBindings({ target: input, keystrokes: key })[0]?.command).toBe(
        "latex-tools:" + command,
      );
    const actions = model.getAvailableActions();
    for (const command of ["open-external", "show-in-folder"]) {
      expect(
        actions
          .find((action) => action.command === "latex-tools:" + command)
          .keystrokes.some((key) => key.includes("f12")),
      ).toBe(false);
    }
  });

  for (const ctrlKey of [false, true])
    it(
      "uses " + (ctrlKey ? "Ctrl-Shift-click" : "Shift-click") + " only to select the clicked row",
      async () => {
        const open = spyOn(lumine.workspace, "open").and.callThrough();
        const actions = jasmine.createSpy("finished action");
        const lease = model.onDidFinishAction(actions);
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          shiftKey: true,
          ctrlKey,
        });
        rowFor(selectedPath).querySelector(".primary-line").dispatchEvent(event);
        await flushMicrotasks();
        lease.dispose();
        expect(model.getSelectedItem().filePath).toBe(selectedPath);
        expect(event.defaultPrevented).toBe(true);
        expect(actions).not.toHaveBeenCalled();
        expect(host.isVisible()).toBe(true);
        expect(lumine.application.openWindow).not.toHaveBeenCalled();
        expect(chooser.pickers.size).toBe(0);
        expect(open).not.toHaveBeenCalled();
        expect(lumine.shell.openPath).not.toHaveBeenCalled();
        expect(lumine.shell.showItemInFolder).not.toHaveBeenCalled();
      },
    );

  it("exposes no Open Pending command or obsolete Enter alias", () => {
    const input = model.getQueryEditor().getElement();
    expect(
      lumine.commands
        .findCommands({ target: input })
        .some(({ name }) => name === "latex-tools:open-pending"),
    ).toBe(false);
    for (const keystrokes of ["shift-enter", "ctrl-shift-enter"]) {
      expect(
        lumine.keymaps
          .findKeyBindings({ target: input, keystrokes })
          .some((binding) => binding.command.startsWith("latex-tools:")),
      ).toBe(false);
    }
  });
});
