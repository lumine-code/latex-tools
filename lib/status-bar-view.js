module.exports = class StatusBarView {
  constructor(callbacks = {}) {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Creating StatusBarView");
    }
    this.callbacks = callbacks;
    this.tooltip = null;
    this.timerInterval = null;
    this.buildStartTime = null;
    this.currentStatus = "";
    this.compileOnSave = false;

    this.element = document.createElement("div");
    this.element.classList.add("latex-tools-status", "inline-block");

    // Create TeX label
    this.label = document.createElement("span");
    this.label.classList.add("latex-tools-status-label");
    this.label.textContent = "TeX";

    // Create timer element
    this.timer = document.createElement("span");
    this.timer.classList.add("latex-tools-status-timer");

    this.element.appendChild(this.label);
    this.element.appendChild(this.timer);

    // Add native editor tooltip
    this.tooltip = atom.tooltips.addComposite(this.element, [
      {
        title: "Compile",
        keyBindingExtra: "LMB",
        keyBindingCommand: "latex-tools:compile",
      },
      {
        title: "Toggle file observation",
        keyBindingExtra: "Alt+LMB",
        keyBindingCommand: "latex-tools:toggle-compile-on-save",
      },
      {
        title: "Split PDF/TeX",
        keyBindingExtra: "MMB",
        keyBindingCommand: "latex-tools:open-pdf",
      },
      {
        title: "Kill & clean",
        keyBindingExtra: "RMB",
        keyBindingCommand: "latex-tools:kill-and-clean",
      },
    ]);

    // Add mousedown handler for all mouse buttons
    this.element.addEventListener("mousedown", (event) => {
      if (atom.config.get("latex-tools.debug")) {
        console.log("[LaTeX Tools] Status bar mousedown, button:", event.button);
      }

      switch (event.button) {
        case 0: // Left mouse button
          if (event.altKey) {
            // Alt+Left click - toggle compile-on-save observation for the active file
            if (this.callbacks.onToggleCompileOnSave) {
              this.callbacks.onToggleCompileOnSave();
            }
          } else {
            // Left click - compile
            if (this.callbacks.onCompile) {
              this.callbacks.onCompile();
            }
          }
          break;
        case 1: // Middle mouse button - open PDF
          event.preventDefault(); // Prevent default middle-click behavior
          if (this.callbacks.onOpenPdf) {
            this.callbacks.onOpenPdf();
          }
          break;
        case 2: // Right mouse button - kill and clean
          if (this.callbacks.onKillAndClean) {
            this.callbacks.onKillAndClean();
          }
          break;
      }
    });

    // Prevent context menu on right click
    this.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return false;
    });

    // Initialize to idle state
    this.setStatus("idle");
    if (atom.config.get("latex-tools.debug")) {
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
    if (atom.config.get("latex-tools.debug")) {
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
        if (atom.config.get("latex-tools.debug")) {
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
        if (atom.config.get("latex-tools.debug")) {
          console.log("[LaTeX Tools] Setting status to success");
        }
        this.stopTimer();
        this.element.classList.add("status-success");
        this.timer.style.display = "";
        // Keep timer visible showing final time
        break;

      case "error":
        if (atom.config.get("latex-tools.debug")) {
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
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Showing status bar view");
    }
    this.element.style.display = "";
  }

  hide() {
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Hiding status bar view");
    }
    this.element.style.display = "none";
  }

  destroy() {
    if (atom.config.get("latex-tools.debug")) {
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
