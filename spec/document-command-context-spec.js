const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("LaTeX document command context", () => {
  let main, directory, editor, source, pdf;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-document-command-")));
    source = path.join(directory, "document.tex");
    pdf = source.replace(/\.tex$/, ".pdf");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(pdf, "Owned inert PDF bytes");
    editor = await lumine.workspace.open(source);
    await lumine.packages.activatePackage("tasks");
    main = (await lumine.packages.activatePackage("latex-tools")).mainModule;
    spyOn(main, "runCompilation").and.returnValue(true);
    spyOn(main, "cleanFile");
    spyOn(main, "_openPdfDirect").and.resolveTo();
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("latex-tools");
    editor?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    const owned = fs.realpathSync(directory);
    if (
      path.dirname(owned) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(owned).startsWith("latex-document-command-")
    )
      throw new Error("Unsafe fixture cleanup");
    fs.rmSync(owned, { recursive: true, force: true });
  });
  const pdfEvent = () => ({ context: { embeddedEditor: null, documentItem: { filePath: pdf } } });

  it("resolves a PDF's source without borrowing the active text editor", () => {
    const document = main.commandDocument(pdfEvent());
    expect(document.filePath).toBe(source);
    expect(document.editor).toBeNull();
    expect(document.pdf).toBe(true);
    expect(main.isCommandAvailable(pdfEvent(), "compile")).toBe(true);
  });
  it("keeps an explicitly empty context empty", async () => {
    expect(main.isCommandAvailable({ context: {} }, "compile")).toBe(false);
    await main.compile({ context: {} });
    expect(main.runCompilation).not.toHaveBeenCalled();
  });
  it("compiles the PDF's source through the ordinary compile command", async () => {
    await main.compile(pdfEvent());
    expect(main.runCompilation).toHaveBeenCalledOnceWith(source);
  });
  it("observes the PDF's source through the shared build service", () => {
    const observe = spyOn(main, "setCompileOnSaveForFile").and.returnValue(true);
    main.toggleCompileOnSave(pdfEvent());
    expect(observe).toHaveBeenCalledOnceWith(source, true, null);
  });
  it("cleans the PDF's source through the ordinary stop-and-clean command", async () => {
    await main.killAndClean(pdfEvent());
    expect(main.cleanFile).toHaveBeenCalledOnceWith(source);
  });
  it("splits a PDF's source into its invoking pane", async () => {
    const event = pdfEvent();
    const pane = lumine.workspace.paneForItem(editor);
    event.context.documentPane = pane;
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});
    await main.openDocumentPair(event);
    expect(open).toHaveBeenCalledOnceWith(source, { split: "left", pane, searchAllPanes: true });
  });
  it("splits a source's PDF into its invoking pane", async () => {
    const pane = lumine.workspace.paneForItem(editor);
    await main.openDocumentPair({
      context: { embeddedEditor: editor, documentItem: editor, documentPane: pane },
    });
    expect(main._openPdfDirect).toHaveBeenCalledOnceWith(pdf, { split: "right", pane }, source);
  });

  it("associates an existing PDF with its closed root when opened from a chapter", async () => {
    const chapter = path.join(directory, "chapter.tex");
    fs.writeFileSync(chapter, "% !TEX root = document.tex\nChapter\n");
    editor.destroy();
    const chapterEditor = await lumine.workspace.open(chapter);
    const associate = spyOn(main.buildService, "associateArtifact").and.returnValue(true);
    const open = spyOn(lumine.workspace, "open").and.callFake(() => {
      expect(associate).toHaveBeenCalledOnceWith(
        { providerId: "latex-tools", filePath: source },
        pdf,
      );
      return Promise.resolve({});
    });
    main._openPdfDirect.and.callThrough();
    try {
      expect(main.buildService.getJobs({ providerId: "latex-tools" })).toEqual([]);
      main.openPdf({ context: { embeddedEditor: chapterEditor, documentItem: chapterEditor } });
      await main._openPdfDirect.calls.mostRecent().returnValue;
      expect(open).toHaveBeenCalledOnceWith(pdf, { searchAllPanes: true });
    } finally {
      chapterEditor.destroy();
    }
  });
  it("uses the explicit document editor while another window is active", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const other = lumine.workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(other, { activatePane: true });
    expect(lumine.workspace.getActiveTextEditor()).toBe(other);
    await main.compile({ context: { embeddedEditor: editor, documentItem: editor } });
    expect(main.runCompilation).toHaveBeenCalledOnceWith(source);
  });
  it("uses an embedded document editor from command dispatch", async () => {
    const element = document.createElement("div");
    const item = {
      getTitle: () => "Embedded source",
      getElement: () => element,
      getActiveEmbeddedTextEditor: () => editor,
    };
    const pane = lumine.workspace.getActivePane();
    pane.activateItem(item);
    try {
      await lumine.commands.dispatch(element, "latex-tools:compile");
      expect(main.runCompilation).toHaveBeenCalledOnceWith(source);
    } finally {
      await pane.destroyItem(item);
    }
  });
});
