// Box overflows ("info") and package narration ("hint") share one verbosity
// gate: both are noise until the user asks for the whole log, and gating only
// one of them would leave the quieter tier as the only one always on screen.
const VERBOSE_ONLY_SEVERITIES = new Set(["info", "hint"]);

module.exports = class LinterProvider {
  constructor() {
    this.name = "LaTeX";
    this.indieInstance = null;
  }

  // Called by linter package to register this indie linter
  register(indie) {
    this.indieInstance = indie;
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Linter indie instance registered");
    }
  }

  setMessages(messages) {
    if (!this.indieInstance) {
      console.warn("[LaTeX Tools] Linter indie instance not available");
      return;
    }

    // Filter messages based on verbosity config
    const verbosity = atom.config.get("latex-tools.outputVerbosity") || "default";

    const filteredMessages = messages.filter((msg) => {
      if (VERBOSE_ONLY_SEVERITIES.has(msg.severity) && verbosity !== "extended") return false;
      return true;
    });

    // Remove duplicates (same severity, file, position, and excerpt)
    const seen = new Set();
    const uniqueMessages = filteredMessages.filter((msg) => {
      const key = `${msg.severity}|${msg.location.fullPath}|${msg.location.position.start.row}:${msg.location.position.start.column}|${msg.excerpt}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    // Convert to linter message format
    const linterMessages = uniqueMessages.map((msg) => {
      const linterMsg = {
        severity: msg.severity,
        location: {
          file: msg.location.fullPath,
          position: [
            [msg.location.position.start.row, msg.location.position.start.column],
            [msg.location.position.end.row, msg.location.position.end.column],
          ],
        },
        excerpt: msg.excerpt,
        description: msg.description || undefined,
      };

      // Add reference to log file if logRange is available
      if (msg.logRange) {
        const logFilePath = msg.location.fullPath.replace(/\.tex$/, ".log");
        linterMsg.reference = {
          file: logFilePath,
          position: [msg.logRange[0][0], msg.logRange[0][1]],
        };
      }

      return linterMsg;
    });

    // Set messages using indie linter API
    this.indieInstance.setAllMessages(linterMessages);
    if (atom.config.get("latex-tools.debug")) {
      console.log(`[LaTeX Tools] Set ${linterMessages.length} messages in linter`);
    }
  }

  clearMessages() {
    if (!this.indieInstance) {
      return;
    }

    this.indieInstance.clearMessages();
    if (atom.config.get("latex-tools.debug")) {
      console.log("[LaTeX Tools] Cleared linter messages");
    }
  }
};
