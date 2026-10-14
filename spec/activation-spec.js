const manifest = require("../package.json");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("latex-tools bootstrap", () => {
  it("uses passive service exchange and JavaScript registration", () => {
    for (const descriptor of Object.values(manifest.providedServices || {})) {
      expect(descriptor.activation).toBeUndefined();
    }
  });

  it("keeps file utilities cold until a TeX operation and resolves its first magic root", async () => {
    const packagePath = path.join(__dirname, "..");
    const utilitiesLoaded = () =>
      Object.values(require.cache).some(
        (entry) =>
          typeof entry?.filename === "string" &&
          entry.filename.startsWith(packagePath) &&
          entry.filename.endsWith("utils.js"),
      );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "latex-bootstrap-"));
    try {
      if (lumine.packages.isPackageLoaded("latex-tools")) {
        await lumine.packages.unloadPackage("latex-tools");
      }
      // Other spec files import utility helpers during collection. Adopt that
      // graph into a package generation, then discard it before the cold check.
      await lumine.packages.startPackage(packagePath);
      await lumine.packages.unloadPackage("latex-tools");
      const main = (await lumine.packages.startPackage(packagePath)).mainModule;
      expect(typeof main.provideLatexTools().compile).toBe("function");
      expect(main.getRootFilePath(path.join(directory, "notes.txt"))).toBeNull();
      expect(utilitiesLoaded()).toBe(false);

      const root = path.join(directory, "main.tex");
      const child = path.join(directory, "child.tex");
      fs.writeFileSync(root, "\\documentclass{article}");
      fs.writeFileSync(child, "% !TEX root = main.tex\nText.");
      expect(main.getRootFilePath(child)).toBe(root);
      expect(utilitiesLoaded()).toBe(true);
    } finally {
      if (lumine.packages.isPackageLoaded("latex-tools")) {
        await lumine.packages.unloadPackage("latex-tools");
      }
      await lumine.fileWatchClient.settlePendingTeardown();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
