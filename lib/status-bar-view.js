module.exports = class StatusBarView {
  constructor() {
    this.destroyed = false;
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Creating StatusBarView");
    }
    this.tooltip = null;
    this.timerInterval = null;
    this.buildStartTime = null;
    this.currentStatus = "";
    this.compileOnSave = false;

    this.element = document.createElement("status-bar-tile");
    this.element.setAttribute("data-context-menu-boundary", "");
    this.element.classList.add("latex-tools-status");

    // Create TeX label
    this.label = document.createElement("span");
    this.label.classList.add("latex-tools-status-label");
    this.label.textContent = "TeX";

    // Create timer element
    this.timer = document.createElement("span");
    this.timer.classList.add("latex-tools-status-timer");

    this.element.appendChild(this.label);
    this.element.appendChild(this.timer);

    this.tooltip = lumine.tooltips.add(this.element, {
      html: false,
      keyBindingCommand: "latex-tools:compile",
      keyBindingTarget: () =>
        lumine.workspace.resolveCommandContext(this.element).embeddedEditor?.getElement() ?? null,
      title: () => {
        const state =
          {
            idle: "Idle",
            building: "Building",
            success: "Build succeeded",
            error: "Build failed",
          }[this.currentStatus] ?? "Idle";
        return `${state}. Compile this document.`;
      },
    });
    this.element.addEventListener("mousedown", (event) => {
      if (this.destroyed) return;
      if (event.button === 0) {
        if (process.platform === "darwin" && event.ctrlKey) return;
        lumine.commands.dispatch(
          this.element,
          event.altKey ? "latex-tools:toggle-compile-on-save" : "latex-tools:compile",
        );
      } else if (event.button === 1) {
        event.preventDefault();
        lumine.commands.dispatch(this.element, "latex-tools:split-pdf-source");
      }
    });

    // Initialize to idle state
    this.setStatus("idle");
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] StatusBarView created");
    }
  }

  formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    return `${seconds}s`;
  }

  startTimer() {
    this.stopTimer();
    this.buildStartTime = Date.now();
    this.timer.textContent = "0s";

    this.timerInterval = setInterval(() => {
      const elapsed = Date.now() - this.buildStartTime;
      this.timer.textContent = this.formatTime(elapsed);
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  getElapsedTime() {
    if (this.buildStartTime) {
      return Date.now() - this.buildStartTime;
    }
    return 0;
  }

  setStatus(status, message = "", options = {}) {
    if (lumine.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] setStatus: ${status}, message: ${message}`);
    }
    this.currentStatus = status;
    this.show();

    // Clear previous classes
    this.element.classList.remove(
      "status-idle",
      "status-building",
      "status-success",
      "status-error",
    );
    this.label.classList.remove("building-animation");

    switch (status) {
      case "building":
        if (lumine.config.get("latex-tools.debug")) {
          console.log("[LaTeX Tools] Setting status to building");
        }
        this.element.classList.add("status-building");
        this.label.classList.add("building-animation");
        this.timer.style.display = "";
        // Only start timer if not restoring (skipTimer option)
        if (!options.skipTimer) {
          this.startTimer();
        }
        break;

      case "success":
        if (lumine.config.get("latex-tools.debug")) {
          console.log("[LaTeX Tools] Setting status to success");
        }
        this.stopTimer();
        this.element.classList.add("status-success");
        this.timer.style.display = "";
        // Keep timer visible showing final time
        break;

      case "error":
        if (lumine.config.get("latex-tools.debug")) {
          console.log("[LaTeX Tools] Setting status to error");
        }
        this.stopTimer();
        this.element.classList.add("status-error");
        this.timer.style.display = "";
        // Keep timer visible showing final time
        break;

      case "idle":
      default:
        // Idle state - show "Idle" text
        this.element.classList.add("status-idle");
        this.timer.style.display = "";
        this.timer.textContent = "Idle";
        this.stopTimer();
        this.buildStartTime = null;
        break;
    }
  }

  // Restore timer state when switching between files
  restoreTimer(startTime) {
    this.stopTimer(); // Clear any existing timer
    if (startTime) {
      this.buildStartTime = startTime;
      const elapsed = Date.now() - startTime;
      this.timer.textContent = this.formatTime(elapsed);

      // Start updating if still building
      this.timerInterval = setInterval(() => {
        const elapsed = Date.now() - this.buildStartTime;
        this.timer.textContent = this.formatTime(elapsed);
      }, 1000);
    }
  }

  // Show final elapsed time without running timer
  showElapsedTime(elapsedMs) {
    this.stopTimer();
    this.timer.textContent = this.formatTime(elapsedMs);
  }

  // Update compile-on-save indicator
  setCompileOnSave(enabled) {
    this.compileOnSave = enabled;
    this.label.textContent = enabled ? "TeX*" : "TeX";
  }

  show() {
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Showing status bar view");
    }
    this.element.style.display = "";
  }

  hide() {
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Hiding status bar view");
    }
    this.element.style.display = "none";
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (lumine.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Destroying StatusBarView");
    }
    this.stopTimer();
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
