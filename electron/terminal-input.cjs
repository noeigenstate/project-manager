// xterm sends protocol replies through onData too. Cursor positions, device
// attributes, focus reports and color replies do not mean the user typed a
// command at the PowerShell prompt. They must still be forwarded to the PTY.
const reply = /^(?:\x1b\[[?>]?[\d;]*(?:R|c|n|t)|\x1b\[[IO]|\x1b\](?:4;\d+|1[012]);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1bP[01]\+r[^\x1b]*\x1b\\)+$/;

function isTerminalResponse(data) {
  return data === '' || reply.test(data);
}

// Each shell event uses its own pipe connection. A later connection can be
// delivered first, so startup must never overwrite a newer prompt-ready event.
function acceptShellEvent(session, event) {
  if (!['shell-ready', 'shell-prompt', 'codex-started', 'codex-exited'].includes(event.type)) return false;
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= (session.lastShellEventSequence || 0)) return false;
  session.lastShellEventSequence = event.sequence;
  return true;
}

module.exports = { isTerminalResponse, acceptShellEvent };
