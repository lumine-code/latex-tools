describe("LaTeX Tools initialization cleanup", () => {
  it("unloads an initial bootstrap before activation subscriptions exist", async () => {
    const pack = lumine.packages.loadPackage("latex-tools");
    pack.requireMainModule();
    pack.initializeForExternalUse("initial package bootstrap");
    const context = pack.lifecycleContext;
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivated).toBe(false);

    await lumine.packages.unloadPackage("latex-tools", { serialize: false });

    expect(context.subscriptions.disposed).toBe(true);
    expect(lumine.packages.isPackageLoaded("latex-tools")).toBe(false);
  });
});
