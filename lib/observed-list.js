const path = require("path");

module.exports = class ObservedFilesList {
  constructor(mainModule) {
    this.mainModule = mainModule;
    this.items = [];

    this.selectList = lumine.workspace.buildSelectList({
      className: "latex-tools-observed-files-list",
      crumb: "Observed Files",
      emptyMessage: "No files observed for compile-on-save",
      placeholderText: "Observed compile-on-save files...",
      getItemId: (item) => item.filePath,
      source: { mode: "snapshot", load: () => this.loadItems() },
      search: { getFilterText: (item) => item.displayPath },
      renderItem: (item, { filterKey, highlight }) => {
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
      commands: {
        "latex-tools:open-selected-file": {
          description: "Open the selected observed file, reusing its pane if it is already open.",
          didDispatch: (event) => this.openSelectedFile(event.detail.item),
        },
        "latex-tools:unobserve-selected-file": {
          description: "Stop compiling the selected file on save and drop it from this list.",
          didDispatch: (event) => this.unobserveSelectedFile(event.detail.item),
        },
      },
      actions: [
        {
          command: "latex-tools:open-selected-file",
          context: "item",
          primary: true,
          group: "File",
          disposition: "close",
          dispatch: "local",
        },
        {
          command: "latex-tools:unobserve-selected-file",
          context: "item",
          group: "File",
          disposition: "stay",
          dispatch: "local",
        },
        {
          command: "latex-tools:clear-all-observed-files",
          context: "dialog",
          when: () => this.items.length > 0,
          group: "All Files",
          tone: "danger",
          disposition: "stay",
          dispatch: "workspace",
        },
      ],
    });
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

  loadItems() {
    this.items = this.buildItems();
    return this.items;
  }

  async update(initialSelectionIndex = null) {
    await this.selectList.setItems(this.loadItems());
    if (initialSelectionIndex != null && this.items.length > 0) {
      await this.selectList.selectIndex(Math.min(initialSelectionIndex, this.items.length - 1));
    }
  }

  openSelectedFile(item = null) {
    item ??= this.selectList.getSelectedItem();
    if (!item) {
      return;
    }

    return lumine.workspace.open(item.filePath, { searchAllPanes: true });
  }

  async unobserveSelectedFile(item = this.selectList.getSelectedItem()) {
    if (!item) {
      return;
    }

    const index = this.selectList.getSelectedIndex() ?? 0;
    this.mainModule.setCompileOnSaveForFile(item.filePath, false);
    lumine.notifications.addHint(`Stopped observing ${path.basename(item.filePath)}`);

    await this.update(Math.max(0, Math.min(index, this.items.length - 2)));
    if (this.items.length === 0) {
      this.selectList.hide();
    }
  }

  show() {
    return this.selectList.show();
  }

  toggle() {
    return this.selectList.toggle();
  }

  destroy() {
    return this.selectList.destroy();
  }
};
