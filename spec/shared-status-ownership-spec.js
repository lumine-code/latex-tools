const manifest = require("../package.json");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Disposable } = require("lumine");

describe("LaTeX shared build status ownership", () => {
  let main, directory, editor, lease;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-shared-status-")));
  });
  afterEach(async () => {
    lease?.dispose();
    editor?.destroy();
    await lumine.packages.deactivatePackage("latex-tools");
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-shared-status-")
    )
      throw new Error("Unsafe fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true });
  });
  it("declares only domain and build services, without a status-bar consumer", () => {
    expect(manifest.consumedServices["status-bar"]).toBeUndefined();
    expect(main.consumeStatusBar).toBeUndefined();
    expect(main.observedFilesList).toBeNull();
  });
  it("does not subscribe when a status-bar service appears", async () => {
    await lumine.packages.deactivatePackage("tasks");
    const observeWindows = jasmine.createSpy("observeWindows").and.returnValue(new Disposable());
    lease = lumine.packages.serviceHub.provide("status-bar", "2.0.0", { observeWindows });
    expect(observeWindows).not.toHaveBeenCalled();
  });
  it("adds no provider tiles or tile menus while a document is observed", async () => {
    await lumine.packages.activatePackage("tasks");
    const source = path.join(directory, "document.tex");
    fs.writeFileSync(source, "source");
    editor = await lumine.workspace.open(source);
    expect(main.setCompileOnSaveForFile(source, true)).toBe(true);
    expect(document.querySelector(".latex-tools-status, .latex-tools-observed-status")).toBeNull();
    expect(
      lumine.contextMenu.itemSets.some((set) =>
        /latex-tools-(?:observed-)?status/.test(set.selector),
      ),
    ).toBe(false);
  });
});
