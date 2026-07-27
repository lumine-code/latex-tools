const path = require("path");

// Pattern for errors starting with !
const FATAL_ERROR_PATTERN = /^! (.+)$/;

// Pattern for file:line:message errors
const FILE_LINE_ERROR_PATTERN = /^(.+\.tex):(\d+): (.+)$/;

// Pattern for line number context (l.123 ...)
const LINE_CONTEXT_PATTERN = /^l\.(\d+)\s(.*)$/;

// Pattern for output file
const OUTPUT_PATTERN = /^Output\swritten\son\s(.*)\s\(.*\)\.$/;

// Pattern for overfull/underfull boxes
const BOX_PATTERN =
  /^((?:Over|Under)full \\[hvd]box \([^)]*\)) (?:in paragraph |in alignment )?at lines? (\d+)(?:--(\d+))?/;

// Pattern for LaTeX/Package/Class warnings
const WARNING_PATTERN = /^(LaTeX|Package|Class)(?:\s+(\S+))?\s+Warning:\s*(.*)$/;

// Pattern for LaTeX/Package/Class info
const INFO_PATTERN = /^(LaTeX|Package|Class)(?:\s+(\S+))?\s+Info:\s*(.*)$/;

// Pattern for "on input line N"
const INPUT_LINE_PATTERN = /on input line (\d+)/;

// Pattern for \input markers surrounded by parentheses
const INPUT_FILE_PATTERN = /(\([^()[\]]+|\))/g;

// Pattern to clean file paths
const INPUT_FILE_TRIM_PATTERN = /(^\([\s"]*|[\s"]+$)/g;

module.exports = class LogParser {
  constructor() {
    this.messages = [];
    this.sourcePaths = [];
    this.projectPath = null;
    this.texFilePath = null;
    this.outputFilePath = null;
    this.lastMessage = null;
  }

  parse(logContent, texFilePath) {
    this.messages = [];
    this.texFilePath = texFilePath;
    this.projectPath = path.dirname(texFilePath);
    this.sourcePaths = [texFilePath];
    this.outputFilePath = null;
    this.lastMessage = null;

    const lines = logContent.split(/\r?\n/);
    let lineIndex = 0;

    while (lineIndex < lines.length) {
      const line = lines[lineIndex];

      // Skip first line (contains confusing patterns)
      if (lineIndex === 0) {
        lineIndex++;
        continue;
      }

      // 1. Check for output file path
      let match = line.match(OUTPUT_PATTERN);
      if (match) {
        const filePath = match[1].replace(/"/g, "");
        this.outputFilePath = path.resolve(this.projectPath, filePath);
        lineIndex++;
        continue;
      }

      // 2. Check for fatal errors (! Error message)
      match = line.match(FATAL_ERROR_PATTERN);
      if (match) {
        const result = this.parseFatalError(match, lines, lineIndex);
        if (result.message) {
          this.addMessage(result.message);
        }
        lineIndex = result.nextIndex;
        continue;
      }

      // 3. Check for file:line:message errors
      match = line.match(FILE_LINE_ERROR_PATTERN);
      if (match) {
        const result = this.parseFileLineError(match, lines, lineIndex);
        if (result.message) {
          this.addMessage(result.message);
        }
        lineIndex = result.nextIndex;
        continue;
      }

      // 4. Check for box warnings (overfull/underfull)
      match = line.match(BOX_PATTERN);
      if (match) {
        const message = this.parseBoxWarning(match, lineIndex);
        if (message) {
          this.addMessage(message);
        }
        lineIndex++;
        continue;
      }

      // 5. Check for warnings (multi-line)
      match = line.match(WARNING_PATTERN);
      if (match) {
        const result = this.parseWarning(match, lines, lineIndex);
        if (result.message) {
          this.addMessage(result.message);
        }
        lineIndex = result.nextIndex;
        continue;
      }

      // 6. Check for info messages (multi-line)
      match = line.match(INFO_PATTERN);
      if (match) {
        const result = this.parseInfo(match, lines, lineIndex);
        if (result.message) {
          this.addMessage(result.message);
        }
        lineIndex = result.nextIndex;
        continue;
      }

      // 7. Track file stack with parentheses
      this.updateFileStack(line);

      lineIndex++;
    }

    return this.messages;
  }

  /**
   * Collect continuation lines for multi-line messages.
   * Handles LaTeX log line wrapping (typically at 79-80 chars).
   * @param {string} initialText - The initial message text (to detect wrapped numbers)
   */
  collectContinuationLines(lines, startIndex, packageName = null, initialText = "") {
    const collected = [];
    let index = startIndex;
    let prevText = initialText;

    while (index < lines.length) {
      const line = lines[index];

      // Check for standard continuation (15+ leading spaces)
      let match = line.match(/^(\s{15,})(.+)$/);
      if (match) {
        collected.push({ text: match[2].trim(), noSpace: false });
        prevText = match[2].trim();
        index++;
        continue;
      }

      // Check for package-specific continuation: (packagename)  text
      if (packageName) {
        const pkgPattern = new RegExp(`^\\(${packageName}\\)\\s+(.+)$`);
        match = line.match(pkgPattern);
        if (match) {
          collected.push({ text: match[1].trim(), noSpace: false });
          prevText = match[1].trim();
          index++;
          continue;
        }
      }

      // Check for wrapped line numbers: previous text ends with "line \d+" and
      // current line starts with digits (completing the wrapped number)
      // This handles LaTeX log wrapping like "on input line 24\n21." -> "line 2421"
      if (/line\s+\d+$/.test(prevText) && /^\d+/.test(line)) {
        const digitMatch = line.match(/^(\d+\.?)\s*(.*)/);
        if (digitMatch) {
          // Join digits without space to complete the number
          collected.push({ text: digitMatch[1], noSpace: true });
          // If there's more text after the digits, add it with space
          if (digitMatch[2]) {
            collected.push({ text: digitMatch[2].trim(), noSpace: false });
          }
          prevText = line;
          index++;
          continue;
        }
      }

      // No more continuation lines
      break;
    }

    // Join collected parts, respecting noSpace flag
    let result = "";
    for (const part of collected) {
      if (part.noSpace || result === "") {
        result += part.text;
      } else {
        result += " " + part.text;
      }
    }

    return { text: result, nextIndex: index };
  }

  /**
   * Parse fatal errors (lines starting with !)
   */
  parseFatalError(match, lines, lineIndex) {
    let messageText = match[1];
    let lineNumber = null;
    let sourceContext = "";
    let nextIndex = lineIndex + 1;

    // Collect additional lines until we hit l.<number> or another pattern
    while (nextIndex < lines.length) {
      const line = lines[nextIndex];

      // Check for line context (l.123 ...)
      const lineMatch = line.match(LINE_CONTEXT_PATTERN);
      if (lineMatch) {
        lineNumber = parseInt(lineMatch[1], 10);
        sourceContext = lineMatch[2];
        nextIndex++;
        break;
      }

      // Check if this starts a new message or is empty
      if (
        line.match(/^(!|LaTeX|Package|Class|Output|Over|Under)/) ||
        line.match(FILE_LINE_ERROR_PATTERN) ||
        line === ""
      ) {
        break;
      }

      // Otherwise it's a continuation of the error message
      // Skip lines that are just whitespace or look like source context
      if (line.trim() && !line.match(/^\s*<.*>$/) && !line.match(/^\s*\.\.\.$/)) {
        messageText += " " + line.trim();
      }

      nextIndex++;
    }

    // Clean up message text
    messageText = messageText.replace(/\s+/g, " ").trim();

    return {
      message: {
        severity: "error",
        excerpt: messageText,
        context: sourceContext || undefined,
        location: {
          file: path.basename(this.getCurrentFile()),
          fullPath: this.getCurrentFile(),
          position: lineNumber
            ? {
                start: { row: lineNumber - 1, column: 0 },
                end: { row: lineNumber - 1, column: Number.MAX_SAFE_INTEGER },
              }
            : {
                start: { row: 0, column: 0 },
                end: { row: 0, column: Number.MAX_SAFE_INTEGER },
              },
        },
        logRange: [
          [lineIndex, 0],
          [nextIndex - 1, lines[nextIndex - 1]?.length || 0],
        ],
      },
      nextIndex,
    };
  }

  /**
   * Parse file:line:message format errors
   */
  parseFileLineError(match, lines, lineIndex) {
    const filePath = match[1];
    const lineNumber = parseInt(match[2], 10);
    let messageText = match[3];
    let nextIndex = lineIndex + 1;

    // Collect continuation lines (indented lines following the error)
    while (nextIndex < lines.length) {
      const line = lines[nextIndex];

      // Stop at empty lines or new messages
      if (
        line === "" ||
        line.match(/^(!|LaTeX|Package|Class|Output|Over|Under)/) ||
        line.match(FILE_LINE_ERROR_PATTERN)
      ) {
        break;
      }

      // Check for line context
      const lineMatch = line.match(LINE_CONTEXT_PATTERN);
      if (lineMatch) {
        nextIndex++;
        break;
      }

      // Continuation line (usually indented)
      if (line.match(/^\s+/) && line.trim()) {
        messageText += " " + line.trim();
      } else {
        break;
      }

      nextIndex++;
    }

    // Skip help messages
    if (messageText.match(/^(The |This |You |See |Type |That makes )/)) {
      return { message: null, nextIndex };
    }

    // Clean up message
    messageText = messageText.replace(/\s+/g, " ").trim();

    // Resolve file path
    const resolvedPath = path.resolve(this.projectPath, filePath);

    return {
      message: {
        severity: "error",
        excerpt: messageText,
        location: {
          file: path.basename(resolvedPath),
          fullPath: resolvedPath,
          position: {
            start: { row: lineNumber - 1, column: 0 },
            end: { row: lineNumber - 1, column: Number.MAX_SAFE_INTEGER },
          },
        },
        logRange: [
          [lineIndex, 0],
          [nextIndex - 1, lines[nextIndex - 1]?.length || 0],
        ],
      },
      nextIndex,
    };
  }

  /**
   * Parse box warnings (overfull/underfull)
   */
  parseBoxWarning(match, lineIndex) {
    const text = match[1];
    const startLine = parseInt(match[2], 10);
    const endLine = match[3] ? parseInt(match[3], 10) : startLine;

    return {
      severity: "info",
      excerpt: text,
      location: {
        file: path.basename(this.getCurrentFile()),
        fullPath: this.getCurrentFile(),
        position: {
          start: { row: startLine - 1, column: 0 },
          end: { row: endLine - 1, column: Number.MAX_SAFE_INTEGER },
        },
      },
      logRange: [
        [lineIndex, 0],
        [lineIndex, 0],
      ],
    };
  }

  /**
   * Parse warning messages (potentially multi-line)
   */
  parseWarning(match, lines, lineIndex) {
    const origin = match[1]; // LaTeX, Package, or Class
    const packageName = match[2] || null;
    let messageText = match[3] || "";
    let nextIndex = lineIndex + 1;

    // Collect continuation lines (pass messageText for wrapped number detection)
    const continuation = this.collectContinuationLines(lines, nextIndex, packageName, messageText);
    if (continuation.text) {
      // Check if continuation starts with digits completing a wrapped line number
      if (/line\s+\d+$/.test(messageText) && /^\d+/.test(continuation.text)) {
        messageText += continuation.text;
      } else {
        messageText += " " + continuation.text;
      }
    }
    nextIndex = continuation.nextIndex;

    // Clean up message
    messageText = messageText.replace(/\s+/g, " ").trim();

    // Extract line number if present
    let lineNumber = null;
    const lineMatch = messageText.match(INPUT_LINE_PATTERN);
    if (lineMatch) {
      lineNumber = parseInt(lineMatch[1], 10);
    }

    // Build the excerpt with origin
    const originText = packageName ? `${origin} ${packageName}` : origin;
    const excerpt = originText !== "LaTeX" ? `${originText}: ${messageText}` : messageText;

    return {
      message: {
        severity: "warning",
        excerpt: excerpt,
        location: {
          file: path.basename(this.getCurrentFile()),
          fullPath: this.getCurrentFile(),
          position: lineNumber
            ? {
                start: { row: lineNumber - 1, column: 0 },
                end: { row: lineNumber - 1, column: Number.MAX_SAFE_INTEGER },
              }
            : {
                start: { row: 0, column: 0 },
                end: { row: 0, column: Number.MAX_SAFE_INTEGER },
              },
        },
        logRange: [
          [lineIndex, 0],
          [nextIndex - 1, lines[nextIndex - 1]?.length || 0],
        ],
      },
      nextIndex,
    };
  }

  /**
   * Parse info messages (potentially multi-line)
   * Reported as "hint": these are the log narrating its own decisions, not a
   * defect in the output the way an overfull box is.
   */
  parseInfo(match, lines, lineIndex) {
    const origin = match[1]; // LaTeX, Package, or Class
    const packageName = match[2] || null;
    let messageText = match[3] || "";
    let nextIndex = lineIndex + 1;

    // Collect continuation lines (pass messageText for wrapped number detection)
    const continuation = this.collectContinuationLines(lines, nextIndex, packageName, messageText);
    if (continuation.text) {
      // Check if continuation starts with digits completing a wrapped line number
      if (/line\s+\d+$/.test(messageText) && /^\d+/.test(continuation.text)) {
        messageText += continuation.text;
      } else {
        messageText += " " + continuation.text;
      }
    }
    nextIndex = continuation.nextIndex;

    // Clean up message
    messageText = messageText.replace(/\s+/g, " ").trim();

    // Extract line number if present
    let lineNumber = null;
    const lineMatch = messageText.match(INPUT_LINE_PATTERN);
    if (lineMatch) {
      lineNumber = parseInt(lineMatch[1], 10);
    }

    // Build the excerpt with origin
    const originText = packageName ? `${origin} ${packageName}` : origin;
    const excerpt = originText !== "LaTeX" ? `${originText}: ${messageText}` : messageText;

    return {
      message: {
        severity: "hint",
        excerpt: excerpt,
        location: {
          file: path.basename(this.getCurrentFile()),
          fullPath: this.getCurrentFile(),
          position: lineNumber
            ? {
                start: { row: lineNumber - 1, column: 0 },
                end: { row: lineNumber - 1, column: Number.MAX_SAFE_INTEGER },
              }
            : {
                start: { row: 0, column: 0 },
                end: { row: 0, column: Number.MAX_SAFE_INTEGER },
              },
        },
        logRange: [
          [lineIndex, 0],
          [nextIndex - 1, lines[nextIndex - 1]?.length || 0],
        ],
      },
      nextIndex,
    };
  }

  updateFileStack(line) {
    // Match all parentheses groups in the line
    const match = line.match(INPUT_FILE_PATTERN);
    if (!match) return;

    for (const token of match) {
      if (token === ")") {
        // Pop file from stack (but keep at least the main tex file)
        if (this.sourcePaths.length > 1) {
          this.sourcePaths.shift();
        }
      } else {
        // Push new file onto stack
        const cleanPath = token.replace(INPUT_FILE_TRIM_PATTERN, "");
        // Only add if it looks like a file path
        if (cleanPath.includes(".")) {
          const resolvedPath = path.resolve(this.projectPath, cleanPath);
          this.sourcePaths.unshift(resolvedPath);
        }
      }
    }
  }

  getCurrentFile() {
    return this.sourcePaths.length > 0 ? this.sourcePaths[0] : this.texFilePath;
  }

  addMessage(message) {
    // Deduplicate: skip if same file, line, and excerpt as last message
    if (
      this.lastMessage &&
      this.lastMessage.location.fullPath === message.location.fullPath &&
      this.lastMessage.location.position.start.row === message.location.position.start.row &&
      this.lastMessage.excerpt === message.excerpt
    ) {
      return;
    }

    this.messages.push(message);
    this.lastMessage = message;
  }

  getMessages() {
    return this.messages;
  }

  getOutputFilePath() {
    return this.outputFilePath;
  }

  clear() {
    this.messages = [];
    this.sourcePaths = [];
    this.lastMessage = null;
    this.outputFilePath = null;
  }

  getStatistics() {
    return {
      total: this.messages.length,
      errors: this.messages.filter((m) => m.severity === "error").length,
      warnings: this.messages.filter((m) => m.severity === "warning").length,
      info: this.messages.filter((m) => m.severity === "info").length,
      hints: this.messages.filter((m) => m.severity === "hint").length,
      outputFile: this.outputFilePath,
    };
  }
};
