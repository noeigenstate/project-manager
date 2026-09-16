const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTerminalResponse, acceptShellEvent, SubmissionTracker } = require('../electron/terminal-input.cjs');

test('terminal protocol responses do not dirty an empty shell prompt', () => {
  for (const response of [
    '', '\x1b[1;1R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n',
    '\x1b[8;24;80t', '\x1b[I', '\x1b[O', '\x1b[1;1R\x1b[?1;2c',
    '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b]11;rgb:0000/0000/0000\x1b\\',
    '\x1bP1+r544e=787465726d\x1b\\',
  ]) assert.equal(isTerminalResponse(response), true, JSON.stringify(response));
});

test('real typing, paste, Enter and mixed user input are still treated as input', () => {
  for (const input of ['codex', 'r', 'c', ' ', '\r', '\n', '中文', '\x7f', '\x1b[A', '\x1b[C', '\x1b[1;5C', '\x1b[200~echo hi\x1b[201~', '\x1b[1;1Rwhoami']) {
    assert.equal(isTerminalResponse(input), false, JSON.stringify(input));
  }
});

test('late startup events cannot overwrite prompt-ready or newer Codex events', () => {
  const session = {};
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-ready', sequence: 1 }), false);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), false);
  assert.equal(acceptShellEvent(session, { type: 'codex-started', sequence: 3 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 2 }), false);
  assert.equal(acceptShellEvent(session, { type: 'codex-exited', sequence: 4 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-prompt', sequence: 5 }), true);
  assert.equal(acceptShellEvent(session, { type: 'shell-ready' }), false);
  assert.equal(acceptShellEvent({}, { type: 'shell-ready', sequence: 1 }), true);
});

test('completion is rearmed by submitted input, not typing, empty Enter or terminal reports', () => {
  const tracker = new SubmissionTracker();
  for (const input of ['', '\r', '   \r', '\x1b[I', '\x1b[O', '\x1b[8;24;80t', '\x1b[?1;2c', '\x1b[1;1R', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b[<0;14;9M', '\x1b[Mabc', '\x1bOP', '\r']) assert.equal(tracker.write(input), false, JSON.stringify(input));
  assert.equal(tracker.write('继续'), false);
  assert.equal(tracker.write('\x1b[D\x1b[C'), false);
  assert.equal(tracker.write('\r'), true);
  assert.equal(tracker.write('\r'), false);
  assert.equal(tracker.write('draft\x15\r'), false, 'cleared input does not submit work');
  assert.equal(tracker.write('修改\x7f\x7f\r'), false);
  assert.equal(tracker.write('cancel\x03\r'), false);
});

test('split multiline paste and editing newlines wait for an explicit submission', () => {
  const tracker = new SubmissionTracker();
  for (const character of '\x1b[200~第一行\r\n第二行\x1b[201~') assert.equal(tracker.write(character), false);
  assert.equal(tracker.write('\n'), false, 'Ctrl+J inserts a newline');
  assert.equal(tracker.write('\x1b\r'), false, 'Alt+Enter inserts a newline');
  assert.equal(tracker.write('\x1b[13;2u'), false, 'modified Enter does not submit');
  assert.equal(tracker.write('\x1b[13u'), true);
  assert.equal(tracker.write('\r'), false);
  assert.equal(tracker.write('\x1b['), false);
  assert.equal(tracker.write('A'), false, 'history selection alone is not a submission');
  assert.equal(tracker.write('\r'), true, 'submitting a recalled prompt is new input');
});
