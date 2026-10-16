const path = require("node:path");
describe("latex-tools command availability", () => {
  let main, editor;
  const can = (name) =>
    lumine.commands.canDispatch(lumine.workspace.getElement(), "latex-tools:" + name);
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
  });
  afterEach(async () => {
    main.buildProcesses.clear();
    main.compileOnSaveFiles.clear();
    editor?.destroy();
    await lumine.packages.deactivatePackage("latex-tools");
  });
  it("keeps setup and view openers available in an empty workspace", () => {
    for (const name of [
      "compile",
      "interrupt",
      "interrupt-all",
      "toggle-compile-on-save",
      "clear-all-observed-files",
      "clean-linter",
    ])
      expect(can(name)).toBeFalse();
    expect(can("observed-files")).toBeTrue();
    expect(can("global-rc")).toBeTrue();
  });
  it("uses only cached file and process metadata for document actions", async () => {
    editor = await lumine.workspace.open();
    expect(can("compile")).toBeFalse();
    editor.getBuffer().setPath(path.join(process.cwd(), "availability.tex"));
    const source = editor.getPath();
    const expensive = spyOn(main, "getRootFilePath").and.throwError(
      "availability must stay passive",
    );
    const text = spyOn(editor, "getText").and.callThrough();
    expect(can("compile")).toBeTrue();
    expect(can("interrupt")).toBeFalse();
    const buildPath = path.join(process.cwd(), "root.tex");
    main.commandRoots.set(source, buildPath);
    main.buildProcesses.set(buildPath, {});
    expect(can("compile")).toBeFalse();
    expect(can("interrupt")).toBeTrue();
    expect(can("interrupt-all")).toBeTrue();
    expect(can("toggle-compile-on-save")).toBeTrue();
    expect(expensive).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(main.observedFilesList).toBeNull();
    main.compileOnSaveFiles.set(source, {});
    expect(can("clear-all-observed-files")).toBeTrue();
    editor.getBuffer().setPath(path.join(process.cwd(), "unrelated.txt"));
    expect(can("compile")).toBeFalse();
    expect(can("interrupt")).toBeFalse();
  });
  it("does not borrow another window's source for an explicitly empty context", async () => {
    editor = await lumine.workspace.open();
    editor.getBuffer().setPath(path.join(process.cwd(), "availability.tex"));
    expect(
      main.isCommandAvailable({ target: lumine.workspace.getElement(), context: {} }, "compile"),
    ).toBeFalse();
  });

  it("cancels compilation when its source closes during the save", async () => {
    editor = await lumine.workspace.open();
    editor.getBuffer().setPath(path.join(process.cwd(), "delayed.tex"));
    editor.setText("unsaved source");
    let finish;
    const saved = new Promise((resolve) => {
      finish = resolve;
    });
    spyOn(editor, "save").and.returnValue(saved);
    const root = spyOn(main, "getRootFilePath").and.throwError(
      "closed source must not resolve a root",
    );
    const build = spyOn(main, "runCompilation");
    const pending = main.compile({ target: editor.getElement() });
    editor.destroy();
    finish();
    await pending;
    expect(root).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("cancels compilation when the root changes path during its save", async () => {
    editor = await lumine.workspace.open();
    editor.getBuffer().setPath(path.join(process.cwd(), "child.tex"));
    const root = await lumine.workspace.open();
    const rootPath = path.join(process.cwd(), "root.tex");
    root.getBuffer().setPath(rootPath);
    root.setText("modified root");
    let finish;
    const saved = new Promise((resolve) => {
      finish = resolve;
    });
    spyOn(root, "save").and.returnValue(saved);
    spyOn(main, "getRootFilePath").and.returnValue(rootPath);
    spyOn(main, "checkBuildStatus").and.returnValue(false);
    const build = spyOn(main, "runCompilation");
    try {
      const pending = main.compile({ target: editor.getElement() });
      expect(root.save).toHaveBeenCalled();
      root.getBuffer().setPath(path.join(process.cwd(), "renamed.tex"));
      finish();
      await pending;
      expect(build).not.toHaveBeenCalled();
    } finally {
      root.destroy();
    }
  });

  it("starts only one status build after concurrent source saves finish", async () => {
    editor = await lumine.workspace.open();
    const filePath = path.join(process.cwd(), "status.tex");
    editor.getBuffer().setPath(filePath);
    editor.setText("modified source");
    let finish;
    const saved = new Promise((resolve) => {
      finish = resolve;
    });
    spyOn(editor, "save").and.returnValue(saved);
    spyOn(main, "statusBarDocument").and.returnValue({ filePath });
    spyOn(main, "getRootFilePath").and.returnValue(filePath);
    spyOn(main, "checkBuildStatus").and.callFake(() => main.buildProcesses.has(filePath));
    const build = spyOn(main, "runCompilation").and.callFake(() =>
      main.buildProcesses.set(filePath, {}),
    );
    const pending = [main.compileFromStatusBar(), main.compileFromStatusBar()];
    expect(build).not.toHaveBeenCalled();
    finish();
    await Promise.all(pending);
    expect(build).toHaveBeenCalledOnceWith(filePath);
  });
});
