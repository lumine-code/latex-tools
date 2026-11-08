const path = require("node:path");

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

function rootForDocument(main, filePath) {
  if (!allowsAutomaticBuild(filePath)) return main.commandRoots?.get(filePath) ?? filePath;
  return main.getRootFilePath(filePath) || filePath;
}

module.exports = { allowsAutomaticBuild, rootForDocument };
