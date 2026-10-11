const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
describe("LaTeX Tools independent external provider edges", () => {
  let main, directory, document, leases;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "latex-owned-edge-")));
    document = path.join(directory, "owned.tex");
    await fs.writeFile(path.join(directory, "owned.pdf"), "Owned inert PDF bytes");
    leases = [];
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("latex-tools");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(await fs.realpath(directory)) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(directory).startsWith("latex-owned-edge-")
    )
      throw Error("Unsafe fixture cleanup");
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  for (const withdrawal of ["older", "newer", "none"]) {
    it(`uses the remaining external provider after ${withdrawal} edge withdraws`, async () => {
      const offer = (label) => {
        const api = { openExternal: jasmine.createSpy(label).and.resolveTo() };
        const lease = lumine.packages.serviceHub.provide("open-external", "1.0.0", api);
        leases.push(lease);
        return { api, lease };
      };
      const older = offer("older"),
        newer = offer("newer");
      if (withdrawal !== "none") (withdrawal === "older" ? older : newer).lease.dispose();
      expect(await main.provideLatexTools().openPdfExternal(document)).toBe(true);
      const expected = withdrawal === "newer" ? older : newer;
      expect(expected.api.openExternal).toHaveBeenCalledOnceWith(path.join(directory, "owned.pdf"));
    });
  }
});
