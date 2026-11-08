const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("LaTeX root discovery for suspended documents", () => {
  let main, directory, filePath, extraEditors;
  beforeEach(async () => {
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "latex-discovery-"));
    filePath = path.join(directory, "source.tex");
    fs.writeFileSync(filePath, "source");
    extraEditors = [];
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
  });
  afterEach(async () => {
    for (const editor of extraEditors) editor.destroy();
    await lumine.packages.deactivatePackage("latex-tools");
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-discovery-")
    )
      throw new Error("Unsafe fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true });
  });
  function createFixture(name, content) {
    const fixture = path.join(directory, name);
    fs.writeFileSync(fixture, content);
    return fixture;
  }
  async function suspend(fixture) {
    const editor = await lumine.workspace.open(fixture);
    extraEditors.push(editor);
    editor.setGrammar(lumine.grammars.nullGrammar);
  }
  it("does not read a suspended sibling root or its recorder during root discovery", async () => {
    const candidate = createFixture("suspended.tex", "\\documentclass{article}\n\\input{source}");
    const recorder = createFixture("suspended.fls", `INPUT ${filePath}\n`);
    await suspend(candidate);
    const read = spyOn(fs, "readFileSync").and.callThrough();
    expect(main.findRootCandidatesForFile(filePath)).toEqual([]);
    const inputs = read.calls.allArgs().map(([input]) => String(input));
    expect(inputs).not.toContain(candidate);
    expect(inputs).not.toContain(recorder);
  });

  it("does not read a suspended included source while inspecting another candidate", async () => {
    const candidate = createFixture("root.tex", "\\documentclass{article}\n\\input{bridge}");
    const included = createFixture("bridge.tex", "\\input{source}");
    await suspend(included);
    const read = spyOn(fs, "readFileSync").and.callThrough();
    expect(main.findRootCandidatesForFile(filePath)).toEqual([]);
    const inputs = read.calls.allArgs().map(([input]) => String(input));
    expect(inputs).toContain(candidate);
    expect(inputs).not.toContain(included);
  });
});
