const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { createEventServer } = require('../electron/events.cjs');

test('actual Windows notify script forwards one complete event and ignores unrelated events', { skip: process.platform !== 'win32' }, async t => {
  const events = [];
  const server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  const run = payload => exec('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../integration/notify.ps1'), '-PipeName', server.name, '-ProjectId', 'test-project', '-SessionKey', 'test-key', '-Payload', JSON.stringify(payload)], { windowsHide: true, timeout: 10000 });
  await run({ type: 'approval-requested' });
  assert.equal(events.length, 0);
  await run({ type: 'agent-turn-complete', 'thread-id': 'thread', 'turn-id': 'turn', 'last-assistant-message': '中文 "quotes" & $value\nnext line' });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'thread:turn');
  assert.equal(events[0].type, 'turn-complete');
  assert.equal(events[0].sessionKey, 'test-key');
  assert.equal(Object.hasOwn(events[0], 'last-assistant-message'), false);
});
