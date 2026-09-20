const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readProjectFile, saveProjectFile, TEXT_PAGE_BYTES } = require('../electron/project-files.cjs');
const { projectPaths } = require('../electron/project-paths.cjs');

test('saving an edited page preserves the rest of a large Unicode file and original BOM/encoding', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-file-edit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = { path: directory };
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
    const original = 'line\r\n中文🙂 '.repeat(50000);
    let body = Buffer.from(original, encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (encoding === 'utf-16be') body = body.swap16();
    const bom = Buffer.from(encoding === 'utf-8' ? [239, 187, 191] : encoding === 'utf-16le' ? [255, 254] : [254, 255]);
    const bytes = Buffer.concat([bom, body]);
    await fs.writeFile(path.join(directory, 'large.txt'), bytes);
    const page = await readProjectFile(project, 'large.txt', 1);
    assert.ok(page.size > TEXT_PAGE_BYTES * 2);
    const content = '替换当前段🙂\n第二行';
    let replacement = Buffer.from(content.replace(/\n/g, '\r\n'), encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (encoding === 'utf-16be') replacement = replacement.swap16();
    await saveProjectFile(project, 'large.txt', 1, page.revision, content);
    assert.deepEqual(await fs.readFile(path.join(directory, 'large.txt')), Buffer.concat([bytes.subarray(0, page.page.byteStart), replacement, bytes.subarray(page.page.byteEnd)]));
  }
});

test('a changed file cannot be overwritten by an old editor revision', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-edit-conflict-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'source.ts'), project = { path: directory };
  await fs.writeFile(filename, 'original');
  const preview = await readProjectFile(project, 'source.ts');
  await fs.writeFile(filename, 'external newer content');
  await assert.rejects(saveProjectFile(project, 'source.ts', 0, preview.revision, 'my draft'), /其他程序修改|变化/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'external newer content');
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('.project-grid-edit-')), []);
  await assert.rejects(saveProjectFile(project, '../outside.txt', 0, preview.revision, 'bad'), /路径/);
  await fs.writeFile(filename, '');
  const empty = await readProjectFile(project, 'source.ts');
  await saveProjectFile(project, 'source.ts', 0, empty.revision, 'new content');
  assert.equal(await fs.readFile(filename, 'utf8'), 'new content');
});

test('path copy preserves selections and uses host-specific absolute paths', () => {
  const local = { path: path.resolve('test project'), kind: 'local' };
  assert.equal(projectPaths(local, ['src/main.ts', 'README.md'], 'relative'), 'src/main.ts\nREADME.md');
  assert.equal(projectPaths(local, ['src/main.ts'], 'absolute'), path.join(local.path, 'src', 'main.ts'));
  assert.equal(projectPaths({ kind: 'ssh' }, ['src/中文.py'], 'absolute', '/srv/my project'), '/srv/my project/src/中文.py');
  assert.equal(projectPaths(local, [''], 'relative'), '.');
  assert.throws(() => projectPaths(local, ['../secret'], 'absolute'), /路径/);
});
