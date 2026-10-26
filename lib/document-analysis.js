const path = require("node:path");
const { CompositeDisposable } = require("lumine");

const keyForPath = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function allowsAutomaticBuild(filePath) {
  const key = keyForPath(filePath);
  let hasOpenEditor = false;
  for (const editor of lumine.workspace.getTextEditors()) {
    if (editor.isDestroyed() || !editor.getPath() || keyForPath(editor.getPath()) !== key) continue;
    if (editor.getGrammar() === lumine.grammars.nullGrammar) return false;
    hasOpenEditor = true;
  }
  return (
    hasOpenEditor || lumine.grammars.getGrammarScore(lumine.grammars.nullGrammar, filePath, "") <= 0
  );
}

function observe(main) {
  const owner = main.subscriptions;
  owner.add(
    lumine.workspace.observeTextEditors((editor) => {
      const pause = () => {
        if (
          main.subscriptions !== owner ||
          owner.disposed ||
          editor.getGrammar() !== lumine.grammars.nullGrammar ||
          !editor.getPath()
        )
          return;
        const filePath = editor.getPath();
        const info = main.compileOnSaveFiles?.get(main.getCompileOnSaveKey(filePath));
        if (info?.timeout) {
          clearTimeout(info.timeout);
          info.timeout = null;
        }
        const root = main.commandRoots?.get(filePath) ?? filePath;
        for (const [runningPath, processInfo] of [...(main.buildProcesses ?? [])]) {
          if (main.subscriptions !== owner || owner.disposed) return;
          if (
            main.buildProcesses.get(runningPath) === processInfo &&
            keyForPath(runningPath) === keyForPath(root)
          )
            main.interruptFile(runningPath);
        }
      };
      const refresh = () => {
        pause();
        if (
          main.subscriptions === owner &&
          !owner.disposed &&
          lumine.workspace.getActiveTextEditor() === editor
        )
          main.updateStatusBarForItem();
      };
      const subscriptions = new CompositeDisposable(
        editor.onDidChangeGrammar(refresh),
        editor.onDidChangePath(refresh),
        editor.onDidDestroy(() => {
          owner.remove(subscriptions);
          subscriptions.dispose();
        }),
      );
      owner.add(subscriptions);
      pause();
    }),
  );
}

function rootForStatus(main, filePath) {
  if (!allowsAutomaticBuild(filePath)) return main.commandRoots?.get(filePath) ?? filePath;
  return main.getRootFilePath(filePath) || filePath;
}

module.exports = { allowsAutomaticBuild, observe, rootForStatus };
