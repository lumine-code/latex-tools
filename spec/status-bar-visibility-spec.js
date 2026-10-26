const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const windowService = require("./helpers/window-service");

describe("latex-tools status visibility", () => {
  let main, directory, host, registrations;

  beforeEach(async () => {
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    jasmine.attachToDOM(lumine.workspace.getElement());
    if (lumine.packages.isPackageLoaded("latex-tools")) {
      await lumine.packages.unloadPackage("latex-tools");
    }
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-visibility-")));
    registrations = [];
    host = document.createElement("div");
    lumine.workspace.getElement().appendChild(host);
  });

  afterEach(async () => {
    for (const registration of registrations) registration.dispose();
    if (lumine.packages.isPackageLoaded("latex-tools")) {
      await lumine.packages.unloadPackage("latex-tools");
    }
    for (const pane of lumine.workspace.getCenter().getPanes()) await pane.destroyItems();
    host.remove();
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(directory).startsWith("latex-visibility-")
    ) {
      throw new Error("Unsafe status visibility fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function activate() {
    main = (await lumine.packages.startPackage(path.join(__dirname, ".."))).mainModule;
    await Promise.resolve();
  }

  function attachStatusBar() {
    const addTile = ({ item }) => {
      host.appendChild(item);
      return { destroy: () => item.remove() };
    };
    registrations.push(
      main.consumeStatusBar(windowService({ addLeftTile: addTile, addRightTile: addTile })),
    );
    return main.statusBarView.getElement();
  }

  function expectHidden() {
    const element = main.statusBarView.getElement();
    expect(main.currentTexFile).toBeNull();
    expect(element.style.display).toBe("none");
    if (element.isConnected) expect(getComputedStyle(element).display).toBe("none");
  }

  function expectVisible(source) {
    expect(main.currentTexFile).toBe(source);
    expect(main.statusBarView.getElement().style.display).toBe("");
    expect(getComputedStyle(main.statusBarView.getElement()).display).not.toBe("none");
  }

  it("keeps its tiles hidden after cold activation in an empty center", async () => {
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBeUndefined();
    await activate();
    expectHidden();

    const tile = attachStatusBar();
    expect(host.contains(tile)).toBe(true);
    expectHidden();
    expect(main.observedFilesStatusView.getElement().style.display).toBe("none");
  });

  it("hides the tile over another item and restores it for the TeX source", async () => {
    await activate();
    attachStatusBar();
    const source = path.join(directory, "document.tex");
    fs.writeFileSync(source, "\\documentclass{article}");
    const editor = await lumine.workspace.open(source);
    expectVisible(source);

    const pane = lumine.workspace.getCenter().getActivePane();
    const other = document.createElement("div");
    pane.activateItem(other);
    expectHidden();

    pane.activateItem(editor);
    expectVisible(source);
    await pane.destroyItem(other);
  });

  it("hides the tile when the last TeX document closes", async () => {
    await activate();
    attachStatusBar();
    const source = path.join(directory, "document.tex");
    fs.writeFileSync(source, "\\documentclass{article}");
    const editor = await lumine.workspace.open(source);
    expectVisible(source);

    await lumine.workspace.getCenter().getActivePane().destroyItem(editor);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBeUndefined();
    expectHidden();
  });

  it("checks the active PDF source when the status-bar service arrives", async () => {
    await activate();
    const source = path.join(directory, "document.tex");
    const element = document.createElement("div");
    const pdf = {
      filePath: path.join(directory, "document.pdf"),
      getTitle: () => "PDF",
      getElement: () => element,
    };
    const pane = lumine.workspace.getCenter().getActivePane();
    pane.activateItem(pdf);
    expectHidden();

    fs.writeFileSync(source, "\\documentclass{article}");
    expect(lumine.workspace.getActiveTextEditor()).toBeUndefined();
    const tile = attachStatusBar();
    expect(host.contains(tile)).toBe(true);
    expectVisible(source);
  });
});
