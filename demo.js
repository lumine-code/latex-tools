// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-latex", "pdf-view"],
  viewport: { width: 1250, height: 760 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("documents/latex-tools/report.tex");
    await lumine.project.setPaths([fixture("documents/latex-tools")]);
    lumine.config.set(
      "latex-tools.latexmkPath",
      process.env.LUMINE_DEMO_LATEXMK || lumine.config.get("latex-tools.latexmkPath") || "latexmk",
    );
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Compile a LaTeX document and inspect the generated PDF beside its source.",
      timeout: 60000,
      async run({ lumine, state, waitFor }) {
        const tools = lumine.packages.getActivePackage("latex-tools").mainModule;
        const source = state.editor.getPath();
        state.pdfPath = source.replace(/\.tex$/, ".pdf");
        await tools.compile();
        await waitFor(
          () => {
            const build = tools.getBuildState(source);
            if (build.status === "error") throw new Error("The LaTeX demo compilation failed");
            return build.status === "success" && require("node:fs").existsSync(state.pdfPath);
          },
          "successful LaTeX compilation and PDF output",
          60000,
        );
        lumine.commands.dispatch(
          lumine.views.getView(state.editor),
          "latex-tools:split-pdf-source",
        );
      },
      async afterPointerMove({ lumine, waitFor }) {
        for (const notice of lumine.notifications.getNotifications()) {
          if (/^(Compiling report\.tex|report\.tex compiled successfully)/.test(notice.message))
            notice.dismiss();
        }
        await waitFor(
          () => !document.querySelector("lumine-notification"),
          "compile notices to close",
        );
      },
      ready({ lumine, state, project, profile }) {
        const viewer = lumine.workspace
          .getPaneItems()
          .find((item) => item.getPath?.() === state.pdfPath);
        const page = viewer?.pdfViewer?.getPageView(0);
        const pdfText = (viewer && lumine.views.getView(viewer)?.innerText) || "";
        const visibleText = `${document.body.innerText}\n${pdfText}`;
        const normalized = visibleText.replace(/\\/g, "/").toLowerCase();
        const hasLocalPath =
          /[a-z]:[\\/]/i.test(visibleText) ||
          [project, profile].some((directory) =>
            normalized.includes(directory.replace(/\\/g, "/").toLowerCase()),
          );
        return Boolean(
          lumine.workspace.getCenter().getPanes().length === 2 &&
          viewer?.pdfDocument?.numPages === 1 &&
          !viewer.loading &&
          page?.renderingState === 3 &&
          pdfText.includes("Signal Lab") &&
          !document.querySelector("lumine-notification") &&
          !hasLocalPath,
        );
      },
    },
  ],
  privacyText({ lumine, state }) {
    const viewer = lumine.workspace
      .getPaneItems()
      .find((item) => item.getPath?.() === state.pdfPath);
    return (viewer && lumine.views.getView(viewer)?.innerText) || "";
  },
  async cleanup() {},
};
