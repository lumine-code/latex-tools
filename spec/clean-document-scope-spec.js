const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");

describe("LaTeX document cleanup scope", () => {
  let directory, editor, projectPaths;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(childProcess, "spawn").and.throwError("No compiler in cleanup fixtures");
    spyOn(childProcess, "execFileSync").and.throwError(
      "No external executable in cleanup fixtures",
    );
    if (lumine.packages.isPackageActive("latex-tools"))
      await lumine.packages.deactivatePackage("latex-tools");
    if (lumine.packages.isPackageLoaded("latex-tools"))
      await lumine.packages.unloadPackage("latex-tools");
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "latex-clean-scope-")),
    );
    projectPaths = lumine.project.getPaths();
    lumine.project.setPaths([directory]);
    for (const name of ["first.tex", "second.tex"])
      fs.writeFileSync(path.join(directory, name), "\\documentclass{article}\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("latex-tools");
    lumine.config.unset("latex-tools.cleanExtensions");
    editor = await lumine.workspace.open(path.join(directory, "first.tex"));
  });

  afterEach(async () => {
    editor?.destroy();
    if (lumine.packages.isPackageActive("latex-tools"))
      await lumine.packages.deactivatePackage("latex-tools");
    if (lumine.packages.isPackageLoaded("latex-tools"))
      await lumine.packages.unloadPackage("latex-tools");
    lumine.project.setPaths(projectPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      const resolved = fs.realpathSync.native(directory);
      const relative = path.relative(fs.realpathSync.native(os.tmpdir()), resolved);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("Unsafe cleanup fixture path");
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
    directory = editor = projectPaths = null;
  });

  function writeAuxiliaries(extension) {
    for (const basename of ["first", "second"])
      fs.writeFileSync(path.join(directory, `${basename}.${extension}`), "owned auxiliary");
  }

  function clean() {
    lumine.commands.dispatch(lumine.workspace.getElement(), "latex-tools:clean");
  }

  it("keeps another document's bibliography and minitoc files with default patterns", () => {
    writeAuxiliaries("bcf-SAVE-ERROR");
    writeAuxiliaries("mtc0");
    clean();
    for (const extension of ["bcf-SAVE-ERROR", "mtc0"]) {
      expect(fs.existsSync(path.join(directory, `first.${extension}`))).toBeFalse();
      expect(fs.existsSync(path.join(directory, `second.${extension}`))).toBeTrue();
    }
    expect(fs.existsSync(editor.getPath())).toBeTrue();
  });

  it("retains document-scoped ordinary extension cleanup", () => {
    writeAuxiliaries("aux");
    clean();
    expect(fs.existsSync(path.join(directory, "first.aux"))).toBeFalse();
    expect(fs.existsSync(path.join(directory, "second.aux"))).toBeTrue();
  });

  it("removes bibliography files once despite overlapping default patterns", () => {
    writeAuxiliaries("bcf");
    writeAuxiliaries("bcf-SAVE-ERROR");
    const unlink = spyOn(fs, "unlinkSync").and.callThrough();
    const success = spyOn(lumine.notifications, "addSuccess").and.callThrough();
    const warning = spyOn(lumine.notifications, "addWarning").and.callThrough();

    clean();

    expect(unlink.calls.allArgs()).toEqual([
      [path.join(directory, "first.bcf")],
      [path.join(directory, "first.bcf-SAVE-ERROR")],
    ]);
    expect(success).toHaveBeenCalledOnceWith("Cleaned 2 auxiliary file(s)", {
      detail: "first.bcf\nfirst.bcf-SAVE-ERROR",
      dismissable: true,
    });
    expect(warning).not.toHaveBeenCalled();
    for (const extension of ["bcf", "bcf-SAVE-ERROR"]) {
      expect(fs.existsSync(path.join(directory, `first.${extension}`))).toBeFalse();
      expect(fs.existsSync(path.join(directory, `second.${extension}`))).toBeTrue();
    }
  });

  it("deduplicates wildcard matches before ordinary extension matches", () => {
    writeAuxiliaries("bcf");
    lumine.config.set("latex-tools.cleanExtensions", ["{basename}.bcf*", "{basename}.*", "bcf"]);
    const unlink = spyOn(fs, "unlinkSync").and.callThrough();
    const warning = spyOn(lumine.notifications, "addWarning").and.callThrough();

    clean();

    expect(unlink).toHaveBeenCalledOnceWith(path.join(directory, "first.bcf"));
    expect(warning).not.toHaveBeenCalled();
    expect(fs.existsSync(editor.getPath())).toBeTrue();
  });

  it("reports an actual deletion failure once when patterns overlap", () => {
    writeAuxiliaries("bcf");
    const unlink = spyOn(fs, "unlinkSync").and.throwError(
      Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    );
    const warning = spyOn(lumine.notifications, "addWarning").and.callThrough();

    clean();

    expect(unlink).toHaveBeenCalledOnceWith(path.join(directory, "first.bcf"));
    expect(warning).toHaveBeenCalledOnceWith("Failed to delete 1 file(s)", {
      detail: "first.bcf",
      dismissable: true,
    });
    expect(fs.existsSync(path.join(directory, "first.bcf"))).toBeTrue();
  });

  it("preserves a user's explicitly configured directory-wide wildcard", () => {
    writeAuxiliaries("bcf-SAVE-ERROR");
    lumine.config.set("latex-tools.cleanExtensions", ["*.bcf*"]);
    clean();
    expect(fs.existsSync(path.join(directory, "first.bcf-SAVE-ERROR"))).toBeFalse();
    expect(fs.existsSync(path.join(directory, "second.bcf-SAVE-ERROR"))).toBeFalse();
  });
});
