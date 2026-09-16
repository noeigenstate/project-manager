// xterm sends protocol replies through onData too. Cursor positions, device
// attributes, focus reports and color replies do not mean the user typed a
// command at the PowerShell prompt. They must still be forwarded to the PTY.
const reply = /^(?:\x1b\[[?>]?[\d;]*(?:R|c|n|t)|\x1b\[[IO]|\x1b\](?:4;\d+|1[012]);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1bP[01]\+r[^\x1b]*\x1b\\)+$/;

function isTerminalResponse(data) {
  return data === '' || reply.test(data);
}

// Observe actual submissions, without storing the user's text. xterm sends
// focus, mouse and protocol reports on this same channel; none are new work.
class SubmissionTracker {
  constructor() { this.reset(); }
  reset() { this.characters = 0; this.hasText = false; this.history = false; this.pasting = false; this.escape = ''; this.mouseBytes = 0; }
  write(data) {
    let submitted = false;
    const enter = () => {
      if (this.hasText || this.history) submitted = true;
      this.characters = 0; this.hasText = false; this.history = false;
    };
    for (const character of data) {
      if (this.mouseBytes) { this.mouseBytes--; continue; }
      if (this.escape) {
        this.escape += character;
        if (['\x1b[', '\x1b]', '\x1bP', '\x1bO'].includes(this.escape)) continue;
        if (this.escape.startsWith('\x1b[')) {
          if (!/[@-~]/.test(character)) { if (this.escape.length > 128) this.escape = ''; continue; }
          const sequence = this.escape; this.escape = '';
          if (sequence === '\x1b[200~') this.pasting = true;
          else if (sequence === '\x1b[201~') this.pasting = false;
          else if (sequence === '\x1b[M') this.mouseBytes = 3;
          else if (!this.pasting && /^\x1b\[(?:1;\d+)?[AB]$/.test(sequence)) this.history = true;
          else if (!this.pasting && /^\x1b\[13(?:;1)?u$/.test(sequence)) enter();
          continue;
        }
        if (this.escape.startsWith('\x1b]') || this.escape.startsWith('\x1bP')) {
          if (character === '\x07' || this.escape.endsWith('\x1b\\') || this.escape.length > 4096) this.escape = '';
          continue;
        }
        if (!this.pasting && ['\x1bOA', '\x1bOB'].includes(this.escape)) this.history = true;
        if (!this.pasting && this.escape === '\x1bOM') enter();
        // Alt+Enter is a newline in Codex, not a submitted prompt.
        this.escape = ''; continue;
      }
      if (character === '\x1b') { this.escape = character; continue; }
      if (this.pasting) { if (character >= ' ') { this.characters++; this.hasText ||= /\S/.test(character); } continue; }
      if (character === '\r') enter();
      else if (character === '\x03' || character === '\x15') { this.characters = 0; this.hasText = false; this.history = false; }
      else if (character === '\x7f' || character === '\b') { this.characters = Math.max(0, this.characters - 1); if (!this.characters) this.hasText = false; }
      else if (character >= ' ') { this.characters++; this.hasText ||= /\S/.test(character); }
    }
    return submitted;
  }
}

// Each shell event uses its own pipe connection. A later connection can be
// delivered first, so startup must never overwrite a newer prompt-ready event.
function acceptShellEvent(session, event) {
  if (!['shell-ready', 'shell-prompt', 'codex-started', 'codex-exited'].includes(event.type)) return false;
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= (session.lastShellEventSequence || 0)) return false;
  session.lastShellEventSequence = event.sequence;
  return true;
}

module.exports = { isTerminalResponse, acceptShellEvent, SubmissionTracker };
