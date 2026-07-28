const path = require("path");

// The compile-on-save observation list. `atom.modals` owns the modal itself, so
// all this module contributes is the ViewSpec — the items, how a row reads, and
// the two verbs that act on one — plus the two lookups callers need to reach a
// list that happens to be up.

const OBSERVED_FILES_VIEW_ID = "latex-tools.observed-files";

function displayPath(filePath) {
  const [projectPath, relativePath] = atom.project.relativizePath(filePath);
  if (projectPath && relativePath) {
    return relativePath;
  }
  return filePath;
}

function buildItems(mainModule) {
  return mainModule.getCompileOnSaveFiles().map((filePath) => {
    const rootPath = mainModule.getRootFilePath(filePath);
    return {
      filePath,
      rootPath,
      displayPath: displayPath(filePath),
      rootDisplayPath: rootPath ? displayPath(rootPath) : "",
    };
  });
}

function observedFilesSpec(mainModule) {
  return {
    id: OBSERVED_FILES_VIEW_ID,
    className: "latex-tools-observed-files-list",
    placeholder: "Observed compile-on-save files...",
    emptyMessage: "No files observed for compile-on-save",
    help:
      "Available commands:\n" +
      "- **Enter**: Open file\n" +
      "- **Ctrl+D**: Stop observing selected file",
    source: () => buildItems(mainModule),
    renderer: {
      // Observed paths are unique — they key the compile-on-save map — so a
      // string identity is safe here and keeps the focus on the same file
      // across a refresh.
      entry: (item) => ({ id: item.filePath, text: item.displayPath }),
      row: (item) => ({
        icon: ["icon-file-text"],
        label: item.displayPath,
        detail: item.rootDisplayPath ? `Root: ${item.rootDisplayPath}` : "Root: unresolved",
      }),
    },
    actions: [
      {
        name: "unobserve-file",
        label: "Stop observing selected file",
        keystroke: "ctrl-d",
        run: ({ item }) => {
          mainModule.setCompileOnSaveForFile(item.filePath, false);
          atom.notifications.addInfo(`Stopped observing ${path.basename(item.filePath)}`);
          // Returning no result closes, which is what the list did once it ran
          // dry. Otherwise `refresh` re-reads the observed set and the default
          // "follow" strategy clamps the focus onto the row that took this
          // one's place.
          const remaining = mainModule.getCompileOnSaveFiles().length;
          return remaining > 0 ? { keepOpen: true, refresh: true } : null;
        },
      },
    ],
    confirm: ({ item }) => {
      atom.workspace.open(item.filePath, { searchAllPanes: true });
    },
  };
}

function activeObservedFilesSession() {
  const session = atom.modals.getActiveSession();
  return session && session.rootSpec.id === OBSERVED_FILES_VIEW_ID ? session : null;
}

module.exports = { OBSERVED_FILES_VIEW_ID, observedFilesSpec, activeObservedFilesSession };
