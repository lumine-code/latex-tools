const { CompositeDisposable } = require("atom");
const path = require("path");

module.exports = class ObservedFilesList {
  constructor(mainModule) {
    this.mainModule = mainModule;
    this.items = [];
    this.disposables = new CompositeDisposable();

    this.selectList = atom.workspace.buildSelectList({
      className: "latex-tools-observed-files-list",
      emptyMessage: "No files observed for compile-on-save",
      placeholderText: "Observed compile-on-save files...",
      helpMarkdown:
        "Available commands:\n" +
        "- **Enter**: Open file\n" +
        "- **Ctrl+D**: Stop observing selected file",
      willShow: () => this.update(),
      filterKeyForItem: (item) => item.displayPath,
      elementForItem: (item, { filterKey, highlight }) => {
        return {
          primary: highlight(filterKey),
          secondary: item.rootDisplayPath ? `Root: ${item.rootDisplayPath}` : "Root: unresolved",
          icon: ["icon-file-text"],
        };
      },
      didConfirmSelection: (item) => {
        this.selectList.hide();
        atom.workspace.open(item.filePath, { searchAllPanes: true });
      },
      didCancelSelection: () => {
        this.selectList.hide();
      },
    });

    this.disposables.add(
      atom.commands.add(this.selectList.element, {
        "latex-tools:unobserve-selected-file": () => this.unobserveSelectedFile(),
      }),
    );
  }

  buildItems() {
    return this.mainModule.getCompileOnSaveFiles().map((filePath) => {
      const rootPath = this.mainModule.getRootFilePath(filePath);
      return {
        filePath,
        rootPath,
        displayPath: this.displayPath(filePath),
        rootDisplayPath: rootPath ? this.displayPath(rootPath) : "",
      };
    });
  }

  displayPath(filePath) {
    const [projectPath, relativePath] = atom.project.relativizePath(filePath);
    if (projectPath && relativePath) {
      return relativePath;
    }
    return filePath;
  }

  update(initialSelectionIndex = null) {
    this.items = this.buildItems();
    const updateOptions = { items: this.items };
    if (initialSelectionIndex != null) {
      updateOptions.initialSelectionIndex = initialSelectionIndex;
    }
    this.selectList.update(updateOptions);
  }

  unobserveSelectedFile() {
    const item = this.selectList.getSelectedItem();
    if (!item) {
      return;
    }

    const index = this.selectList.selectionIndex ?? 0;
    this.mainModule.setCompileOnSaveForFile(item.filePath, false);
    atom.notifications.addInfo(`Stopped observing ${path.basename(item.filePath)}`);

    this.update(Math.max(0, Math.min(index, this.items.length - 2)));
    if (this.items.length === 0) {
      this.selectList.hide();
    }
  }

  show() {
    this.selectList.show();
  }

  toggle() {
    this.selectList.toggle();
  }

  destroy() {
    this.disposables.dispose();
    this.selectList.destroy();
  }
};
