const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("child_process");

describe("LaTeX build data and process ownership", () => {
  let main, directory, nodePath, children, nativeSpawn;
  const exit = (child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));
  const ready = (child) =>
    new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
  beforeEach(async () => {
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    await lumine.packages.deactivatePackage("latex-tools");
    if (lumine.packages.getLoadedPackage("latex-tools"))
      await lumine.packages.unloadPackage("latex-tools");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "latex-owned-build-"));
    children = [];
    nodePath = cp
      .execFileSync("node", ["-p", "process.execPath"], {
        encoding: "utf8",
        windowsHide: true,
      })
      .trim();
    const helper = path.join(directory, "compiler.cjs");
    fs.writeFileSync(
      helper,
      'process.stdout.write("ready"); process.stdin.once("data", (data) => process.exit(Number(data) || 0));',
    );
    nativeSpawn = cp.spawn;
    spyOn(cp, "spawn").and.callFake((command) => {
      if (command !== "owned-audit-compiler") throw new Error("Unexpected compiler command");
      const child = nativeSpawn(nodePath, [helper], { windowsHide: true });
      children.push(child);
      return child;
    });
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    spyOn(main, "killProcess").and.callFake((child) => {
      if (!children.includes(child)) throw new Error("Foreign process");
      child.kill();
    });
    lumine.config.set("latex-tools.latexmkPath", "owned-audit-compiler");
    spyOn(main, "getRootFilePath").and.callFake((file) => file);
    spyOn(main, "parseLogFile");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("latex-tools");
    for (const child of children) {
      child.kill();
      await exit(child);
    }
    const owned = fs.realpathSync(directory);
    const temporary = fs.realpathSync(os.tmpdir());
    const relative = path.relative(temporary, owned);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe owned scratch cleanup");
    fs.rmSync(owned, { recursive: true, force: true });
  });

  it("preserves source and PDF when simple clean extensions name them", () => {
    const source = path.join(directory, "document.tex");
    const pdf = path.join(directory, "document.pdf");
    const auxiliary = path.join(directory, "document.aux");
    for (const file of [source, pdf, auxiliary]) fs.writeFileSync(file, "owned contents");
    lumine.config.set("latex-tools.cleanExtensions", ["tex", "pdf", "aux"]);
    main.cleanFile(source);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(pdf)).toBe(true);
    expect(fs.existsSync(auxiliary)).toBe(false);
  });

  it("preserves uppercase source/output in a wildcard clean and removes only auxiliaries", () => {
    const source = path.join(directory, "document.tex");
    for (const name of ["document.tex", "document.TEX", "document.PDF", "document.aux"])
      fs.writeFileSync(path.join(directory, name), "owned contents");
    lumine.config.set("latex-tools.cleanExtensions", ["{basename}.*"]);
    main.cleanFile(source);
    expect(fs.existsSync(path.join(directory, "document.TEX"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "document.PDF"))).toBe(true);
    expect(fs.existsSync(path.join(directory, "document.aux"))).toBe(false);
  });

  it("runs the configured SyncTeX binary with one literal PDF argument", async () => {
    const binary = path.join(
      directory,
      process.platform === "win32" ? "custom-sync.exe" : "custom-sync",
    );
    fs.copyFileSync(nodePath, binary);
    if (process.platform !== "win32") fs.chmodSync(binary, 0o755);
    const shim = path.join(directory, "synctex-shim.cjs");
    const receipt = path.join(directory, "arguments.json");
    const source = path.join(directory, "source & document.tex");
    const pdf = path.join(
      directory,
      process.platform === "win32"
        ? "output & document.pdf"
        : 'output " $(owned-literal) & document.pdf',
    );
    fs.writeFileSync(pdf.replace(/\.pdf$/, ".synctex.gz"), "owned synchronization marker");
    fs.writeFileSync(
      shim,
      `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(1))); process.stdout.write(${JSON.stringify(`Input:${source}\nLine:12\nColumn:3\n`)}); process.exit(0);`,
    );
    lumine.config.set("latex-tools.synctexPath", binary);
    const unsafe = spyOn(cp, "execSync").and.throwError(
      "Shell transport is prohibited in this control",
    );
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(shim)}`;
    let result;
    try {
      result = await main.syncToSource(pdf, 2, 1.5, 3.25);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
    expect(result).toEqual({ file: source, line: 12, column: 3 });
    expect(unsafe).not.toHaveBeenCalled();
    const args = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : [];
    expect(path.basename(args[0] || "")).toBe("edit");
    expect(args.slice(1)).toEqual(["-o", `2:1.5:3.25:${pdf}`]);
  });

  it("keeps the replacement process tracked when the earlier native child exits", async () => {
    const file = path.join(directory, "document.tex");
    fs.writeFileSync(file, "owned source");
    main.runCompilation(file);
    const first = children[0];
    await ready(first);
    main.runCompilation(file);
    const second = children[1];
    await ready(second);
    const finished = spyOn(main.buildService, "finishBuild").and.callThrough();
    first.stdin.write("finish\n");
    await exit(first);
    expect(main.buildProcesses.get(file)?.process).toBe(second);
    expect(main.checkBuildStatus(file)).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    second.stdin.write("finish\n");
    await exit(second);
    expect(main.buildProcesses.has(file)).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("does not launch a child through a retired service and keeps the replacement service live", async () => {
    const file = path.join(directory, "document.tex");
    fs.writeFileSync(file, "owned source");
    const retired = main.provideLatexTools();
    await lumine.packages.deactivatePackage("latex-tools");
    expect(retired.compile(file)).toBe(false);
    expect(children.length).toBe(0);
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    spyOn(main, "getRootFilePath").and.callFake((source) => source);
    spyOn(main, "killProcess").and.callFake((child) => child.kill());
    spyOn(main, "parseLogFile");
    expect(main.provideLatexTools().compile(file)).toBe(true);
    const child = children.at(-1);
    await ready(child);
    child.stdin.write("finish\n");
    await exit(child);
    expect(main.buildProcesses.has(file)).toBe(false);
  });

  for (const code of [0, 1]) {
    it(`keeps the next command build live when message delivery reenters a completion with code ${code}`, async () => {
      const file = path.join(directory, "document.tex");
      fs.writeFileSync(file, "owned source");
      await lumine.workspace.open(file);
      main.parseLogFile.and.callThrough();
      const service = main.provideLatexTools();
      const completed = jasmine.createSpy("accepted completion");
      const completionLease =
        code === 0 ? service.onDidFinishBuild(completed) : service.onDidFailBuild(completed);
      let reentered = false;
      const messagesLease = service.onDidUpdateMessages(() => {
        if (reentered) return;
        reentered = true;
        lumine.commands.dispatch(lumine.workspace.getElement(), "latex-tools:compile");
      });
      const statuses = [];
      const statusLease = service.onDidChangeBuildStatus(({ status }) => statuses.push(status));
      try {
        lumine.commands.dispatch(lumine.workspace.getElement(), "latex-tools:compile");
        const first = children[0];
        await ready(first);
        first.stdin.write(`${code}\n`);
        await exit(first);
        expect(reentered).toBe(true);
        expect(completed).toHaveBeenCalledTimes(1);
        expect(children.length).toBe(2);
        const second = children[1];
        expect(main.buildProcesses.get(file)?.process).toBe(second);
        expect(service.isBuilding(file)).toBe(true);
        expect(statuses.at(-1)).toBe("building");
        await ready(second);
        second.stdin.write("0\n");
        await exit(second);
        expect(service.isBuilding(file)).toBe(false);
        expect(service.getStatus(file).status).toBe("success");
        expect(completed.calls.count()).toBe(code === 0 ? 2 : 1);
      } finally {
        messagesLease.dispose();
        completionLease.dispose();
        statusLease.dispose();
      }
    });
  }

  it("does not launch a compiler after native build-start delivery retires the package", async () => {
    const file = path.join(directory, "document.tex");
    fs.writeFileSync(file, "owned source");
    await lumine.workspace.open(file);
    const service = main.provideLatexTools();
    let retiring;
    const lease = service.onDidStartBuild(() => {
      retiring = main.deactivate();
    });
    try {
      lumine.commands.dispatch(lumine.workspace.getElement(), "latex-tools:compile");
      await retiring;
      expect(main.subscriptions.disposed).toBe(true);
      expect(service.compile(file)).toBe(false);
      expect(children.length).toBe(0);
    } finally {
      lease.dispose();
    }
  });

  it("finishes the service state when the tracked native child terminates by signal", async () => {
    const file = path.join(directory, "document.tex");
    fs.writeFileSync(file, "owned source");
    const service = main.provideLatexTools();
    const failed = jasmine.createSpy("signal failure");
    const lease = service.onDidFailBuild(failed);
    try {
      main.runCompilation(file);
      const child = children[0];
      await ready(child);
      child.kill();
      await exit(child);
      expect(main.buildProcesses.has(file)).toBe(false);
      expect(service.isBuilding(file)).toBe(false);
      expect(failed).toHaveBeenCalledTimes(1);
    } finally {
      lease.dispose();
    }
  });
});
