// Capture Codex's configured session-id OSC title from this exact PTY. It
// gives same-folder terminals distinct owners without changing user config.
class TerminalTitleTracker {
  constructor() { this.buffer = ''; }
  write(data) {
    this.buffer += data;
    const ids = [];
    const pattern = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match, end = 0;
    while ((match = pattern.exec(this.buffer))) {
      const value = match[1].trim();
      if (/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) ids.push(value);
      end = pattern.lastIndex;
    }
    if (end) this.buffer = this.buffer.slice(end);
    this.buffer = this.buffer.slice(-8192);
    return ids;
  }
}
module.exports = { TerminalTitleTracker };
