const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createEventServer } = require('../electron/events.cjs');

function send(address, chunks) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.on('connect', () => { for (const chunk of chunks) socket.write(chunk); });
    socket.on('close', resolve);
    socket.on('error', reject);
  });
}
test('completion transport accepts fragmented UTF-8 JSON and isolates malformed clients', async t => {
  const events = [];
  const server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  await send(server.address, ['{invalid}\n']);
  await send(server.address, ['{}\n']);
  await send(server.address, ['{"projectId":"中文",', '"sessionKey":"test-key","type":"turn-complete","eventId":"one"}\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].projectId, '中文');
});
