const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { downloadAsset, validateAudio } = require('../electron/voice.cjs');
const { wavFromSamples } = require('../src/voice-audio.ts');

test('microphone encoder makes bounded mono 16 kHz WAV with safe clipping', () => {
  const samples = new Float32Array(16000); samples[0] = 2; samples[1] = -2; samples[2] = .5;
  const bytes = validateAudio(wavFromSamples(samples));
  assert.equal(bytes.readInt16LE(44), 32767); assert.equal(bytes.readInt16LE(46), -32768); assert.equal(bytes.readInt16LE(48), 16384);
  assert.throws(() => validateAudio(Buffer.from('invalid audio')), /无效/);
  const corrupt = Buffer.from(bytes); corrupt.writeUInt32LE(1, 40); assert.throws(() => validateAudio(corrupt), /无效/);
  assert.throws(() => validateAudio(wavFromSamples(new Float32Array(100))), /太短/);
});

test('offline model download resumes verified bytes and rejects corrupt content', async t => {
  const prefix = path.join(os.tmpdir(), 'project-grid-voice-test-'); const folder = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(folder).startsWith(prefix)); await fs.rm(folder, { recursive: true, force: true }); });
  const bytes = Buffer.from('verified model fixture');
  const asset = { url: 'https://example.invalid/model', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const filename = path.join(folder, 'model.bin'); await fs.writeFile(filename + '.partial', bytes.subarray(0, 5));
  const progress = [];
  await downloadAsset(asset, filename, async (_url, options) => { assert.equal(options.headers.Range, 'bytes=5-'); return new Response(bytes.subarray(5), { status: 206, headers: { 'Content-Range': `bytes 5-${bytes.length - 1}/${bytes.length}` } }); }, new AbortController().signal, value => progress.push(value));
  assert.deepEqual(await fs.readFile(filename), bytes); assert.equal(progress.at(-1), bytes.length);
  const bad = path.join(folder, 'bad.bin');
  await assert.rejects(downloadAsset(asset, bad, async () => new Response(Buffer.alloc(bytes.length, 1)), new AbortController().signal, () => {}), /校验失败/);
  await assert.rejects(fs.stat(bad)); await assert.rejects(fs.stat(bad + '.partial'));
});
