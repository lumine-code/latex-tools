module.exports = class ObservedFilesStatusView {
  constructor(callbacks = {}) {
    this.destroyed = false;
    this.callbacks = callbacks;
    this.count = 0;
    this.tooltip = null;

    const ownerDocument = callbacks.document ?? document;
    this.element = ownerDocument.createElement("status-bar-tile");
    this.element.setAttribute("data-context-menu-boundary", "");
    this.element.classList.add("latex-tools-observed-status");

    this.icon = ownerDocument.createElement("span");
    this.icon.classList.add("icon", "icon-eye");
    this.element.appendChild(this.icon);

    this.label = ownerDocument.createElement("span");
    this.label.classList.add("latex-tools-observed-status-label");
    this.element.appendChild(this.label);

    this.tooltip = lumine.tooltips.add(this.element, {
      title: "List observed files. Right click for observation actions.",
    });

    this.element.addEventListener("click", (event) => {
      if (this.destroyed || event.button !== 0 || (process.platform === "darwin" && event.ctrlKey))
        return;
      event.preventDefault();
      if (this.callbacks.dispatch)
        this.callbacks.dispatch(this.element, "latex-tools:observed-files");
      else lumine.commands.dispatch(this.element, "latex-tools:observed-files");
    });

    this.setCount(0);
  }

  setCount(count) {
    this.count = count;
    this.label.textContent = `TeX (${count})`;
    this.element.title = `${count} file${count === 1 ? "" : "s"} observed for compile-on-save`;
    this.element.style.display = count > 0 ? "" : "none";
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.tooltip) {
      this.tooltip.dispose();
      this.tooltip = null;
    }
    this.element.remove();
  }

  getElement() {
    return this.element;
  }
};
