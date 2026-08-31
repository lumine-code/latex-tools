const { CompositeDisposable } = require("lumine");
const path = require("path");

module.exports = class ObservedFilesList {
  constructor(mainModule) {
    this.mainModule = mainModule;
    this.items = [];
    this.disposables = new CompositeDisposable();

    this.selectList = lumine.workspace.buildSelectList({
      className: "latex-tools-observed-files-list",
      crumb: "Observed Files",
      emptyMessage: "No files observed for compile-on-save",
      placeholderText: "Observed compile-on-save files...",
      confirmAction: "latex-tools:open-selected-file",
      additionalActionCommands: ["latex-tools:clear-all-observed-files"],
      actionsFilter: (descriptor) =>
        descriptor.name !== "latex-tools:clear-all-observed-files" || this.items.length > 0,
      idForItem: (item) => item.filePath,
      willShow: () => this.update(),
      filterKeyForItem: (item) => item.displayPath,
      elementForItem: (item, { filterKey, highlight }) => {
        return {
          primary: highlight(filterKey),
          secondary: item.rootDisplayPath ? `Root: ${item.rootDisplayPath}` : "Root: unresolved",
          didRender: (element) =>
            lumine.icons.applyTo(
              element.querySelector(".primary-line"),
              {
                path: item.filePath,
                context: "latex-tools-observed-files",
                hints: { directory: false },
              },
              { setData: false },
            ),
        };
      },
      didConfirmSelection: (item) => this.openSelectedFile(item),
      didCancelSelection: () => {
        this.selectList.hide();
      },
    });

    // The item-actions list derives its rows — label, description,
    // keybinding — from this registration and the keymap.
    this.disposables.add(
      lumine.commands.add(this.selectList.element, {
        "latex-tools:open-selected-file": {
          description: "Open the selected observed file, reusing its pane if it is already open.",
          didDispatch: () => this.openSelectedFile(),
        },
        "latex-tools:unobserve-selected-file": {
          description: "Stop compiling the selected file on save and drop it from this list.",
          didDispatch: () => this.unobserveSelectedFile(),
        },
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
    const [projectPath, relativePath] = lumine.project.relativizePath(filePath);
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
    return this.selectList.update(updateOptions);
  }

  openSelectedFile(item = null) {
    item ??= this.selectList.getSelectedItem();
    if (!item) {
      return;
    }

    this.selectList.hide();
    return lumine.workspace.open(item.filePath, { searchAllPanes: true });
  }

  unobserveSelectedFile() {
    const item = this.selectList.getSelectedItem();
    if (!item) {
      return;
    }

    const index = this.selectList.selectionIndex ?? 0;
    this.mainModule.setCompileOnSaveForFile(item.filePath, false);
    lumine.notifications.addHint(`Stopped observing ${path.basename(item.filePath)}`);

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
