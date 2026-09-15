const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileOperations, cleanName, selections } = require('../electron/file-operations.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'project-grid-file-ops-');
  const directory = await fs.mkdtemp(prefix);
  const project = { id: 'test-project', kind: 'local', path: path.join(directory, 'project') };
  await fs.mkdir(project.path); await fs.mkdir(path.join(directory, 'trash')); await fs.mkdir(path.join(directory, 'outside'));
  let clipboard = []; let confirm = true;
  const service = new FileOperations({ integrationDir: path.resolve(__dirname, '../integration'), cacheRoot: path.join(directory, 'cache'),
    clipboard: async (action, paths) => action === 'copy' ? (clipboard = paths) : clipboard,
    trash: filename => fs.rename(filename, path.join(directory, 'trash', path.basename(filename))), confirmDelete: async () => confirm,
  });
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(prefix)); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, project, service, getClipboard: () => clipboard, setClipboard: paths => { clipboard = paths; }, confirm: value => { confirm = value; } };
}

test('file creation and rename preserve existing content and accept Chinese names', async t => {
  const { project, service } = await fixture(t);
  assert.deepEqual(await service.create(project, '', '素材', 'directory'), { path: '素材', kind: 'directory' });
  await service.create(project, '素材', '说明.txt', 'file');
  await fs.writeFile(path.join(project.path, '素材/说明.txt'), '保留内容');
  await assert.rejects(service.create(project, '素材', '说明.txt', 'file'));
  await service.rename(project, '素材/说明.txt', '说明 新版.txt');
  assert.equal(await fs.readFile(path.join(project.path, '素材/说明 新版.txt'), 'utf8'), '保留内容');
  await service.create(project, '素材', 'existing.txt', 'file');
  await assert.rejects(service.rename(project, '素材/说明 新版.txt', 'existing.txt'), /已存在/);
  assert.equal(await fs.readFile(path.join(project.path, '素材/说明 新版.txt'), 'utf8'), '保留内容');
  for (const name of ['..', '../outside', 'name.', 'name ', 'CON', 'bad:name', 'bad\0name']) assert.throws(() => cleanName(name));
});

test('file clipboard copy uses actual files; paste chooses a fresh name and keeps source data', async t => {
  const { project, service, getClipboard } = await fixture(t);
  await fs.writeFile(path.join(project.path, '报告.txt'), 'COPY CONTENT');
  await service.copy(project, ['报告.txt']);
  assert.deepEqual(getClipboard(), [await fs.realpath(path.join(project.path, '报告.txt'))]);
  const result = await service.paste(project, '');
  assert.deepEqual(result.pasted, ['报告 - 副本.txt']);
  assert.equal(await fs.readFile(path.join(project.path, '报告 - 副本.txt'), 'utf8'), 'COPY CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, '报告.txt'), 'utf8'), 'COPY CONTENT');
  const next = await service.paste(project, '');
  assert.deepEqual(next.pasted, ['报告 - 副本 (2).txt']);
});

test('folder paste is recursive and cannot copy a folder into itself', async t => {
  const { directory, project, service, setClipboard } = await fixture(t);
  const source = path.join(directory, 'outside', '素材'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'image.bin'), Buffer.alloc(1024 * 1024 + 17, 7));
  setClipboard([source]); await service.paste(project, '');
  assert.deepEqual(await fs.readFile(path.join(project.path, '素材/image.bin')), await fs.readFile(path.join(source, 'image.bin')));
  setClipboard([path.join(project.path, '素材')]);
  await assert.rejects(service.paste(project, '素材'), /自身内部/);
  assert.deepEqual(selections(['folder', 'folder/a.txt', 'file.txt']), ['folder', 'file.txt']);
});

test('delete honors cancellation, uses the trash callback and protects the project root', async t => {
  const { project, service, directory, confirm } = await fixture(t);
  await fs.writeFile(path.join(project.path, 'delete.txt'), 'RECOVERABLE');
  confirm(false); assert.deepEqual(await service.remove(project, ['delete.txt']), { deleted: [] });
  assert.equal(await fs.readFile(path.join(project.path, 'delete.txt'), 'utf8'), 'RECOVERABLE');
  confirm(true); await service.remove(project, ['delete.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'trash/delete.txt'), 'utf8'), 'RECOVERABLE');
  await assert.rejects(service.remove(project, ['']));
  await assert.rejects(service.remove(project, ['../outside']));
});

test('mutations reject escaping links and deleting a link preserves its target', async t => {
  const { project, service, directory } = await fixture(t);
  const outside = path.join(directory, 'outside'); await fs.writeFile(path.join(outside, 'keep.txt'), 'KEEP');
  await fs.symlink(outside, path.join(project.path, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.create(project, 'external', 'new.txt', 'file'), /项目/);
  await assert.rejects(service.rename(project, 'external/keep.txt', 'renamed.txt'), /项目/);
  await service.remove(project, ['external']);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP');
});
