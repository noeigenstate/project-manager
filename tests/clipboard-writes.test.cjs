const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardWrites } = require('../electron/clipboard-writes.cjs');

test('a prepared old file copy cannot overwrite a newer path copy', async () => {
  const writes = new ClipboardWrites(), file = writes.reserve(); let clipboard = 'old';
  assert.equal(await writes.commit(writes.reserve(), async () => { clipboard = 'picture.png'; }), true);
  assert.equal(await writes.commit(file, async () => { clipboard = 'FileDrop'; }), false);
  assert.equal(clipboard, 'picture.png');
});

test('path copy waits for an in-flight native file write and its own async text write', async () => {
  const writes = new ClipboardWrites(); let releaseFile, releaseText, clipboard = 'old', settled = false;
  const file = writes.commit(writes.reserve(), async () => { await new Promise(resolve => { releaseFile = resolve; }); clipboard = 'FileDrop'; });
  await Promise.resolve();
  const text = writes.commit(writes.reserve(), async () => { await new Promise(resolve => { releaseText = resolve; }); clipboard = 'picture.png'; }).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(releaseText, undefined);
  releaseFile(); assert.equal(await file, false);
  await Promise.resolve(); assert.equal(settled, false); assert.equal(clipboard, 'FileDrop');
  releaseText(); assert.equal(await text, true); assert.equal(clipboard, 'picture.png');
});

test('failed clipboard writes report errors without blocking future copying', async () => {
  const writes = new ClipboardWrites();
  await assert.rejects(writes.commit(writes.reserve(), async () => { throw new Error('clipboard busy'); }), /clipboard busy/);
  assert.equal(await writes.commit(writes.reserve(), async () => {}), true);
});
