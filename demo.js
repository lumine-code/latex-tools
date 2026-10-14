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
    lumine.config.set("latex-tools.latexmkPath", process.env.LUMINE_DEMO_LATEXMK || "latexmk");
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Compile a LaTeX document and inspect the generated PDF beside its source.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          await lumine.packages.getActivePackage("latex-tools").mainModule.compile();
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        {
          lumine.commands.dispatch(
            lumine.views.getView(state.editor),
            "latex-tools:split-pdf-source",
          );
        }
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
      ready(context) {
        const { lumine } = context;
        return Boolean(
          lumine.workspace.getCenter().getPanes().length === 2 &&
          lumine.workspace.getPaneItems().some((i) => i.getPath?.()?.endsWith(".pdf")),
        );
      },
    },
  ],
  async cleanup() {},
};
