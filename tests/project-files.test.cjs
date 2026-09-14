const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listDirectory, readProjectFile } = require('../electron/project-files.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'project-grid-files-');
  const directory = await fs.mkdtemp(prefix);
  const projectPath = path.join(directory, "中文 [项目] & '空格'");
  await fs.mkdir(projectPath);
  t.after(async () => {
    const target = path.resolve(directory);
    assert.ok(target.startsWith(prefix));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { directory, project: { path: projectPath } };
}

test('explorer reads real directories lazily, keeps dotfiles, and sorts folders first', async t => {
  const { project } = await fixture(t);
  await fs.mkdir(path.join(project.path, 'src'));
  await fs.writeFile(path.join(project.path, 'src', 'nested.ts'), 'export const answer = 42;');
  await fs.writeFile(path.join(project.path, 'README.md'), '# project');
  await fs.writeFile(path.join(project.path, '.gitignore'), 'node_modules');
  const root = await listDirectory(project);
  assert.equal(root.entries[0].name, 'src');
  assert.equal(root.entries[0].kind, 'directory');
  assert.ok(root.entries.some(entry => entry.name === '.gitignore'));
  assert.ok(!root.entries.some(entry => entry.name === 'nested.ts'));
  const child = await listDirectory(project, 'src');
  assert.equal(child.entries[0].path, 'src/nested.ts');
});

test('large folders can be paged without dropping or duplicating entries', async t => {
  const { project } = await fixture(t);
  await Promise.all(Array.from({ length: 215 }, (_, index) => fs.writeFile(path.join(project.path, `file-${index}.txt`), '')));
  const first = await listDirectory(project);
  assert.equal(first.entries.length, 200);
  assert.equal(first.nextOffset, 200);
  const second = await listDirectory(project, '', first.nextOffset);
  assert.equal(second.entries.length, 15);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 215);
});

test('text previews preserve Unicode, source markup, empty files, and UTF-16 BOM text', async t => {
  const { project } = await fixture(t);
  const content = '<script>notExecuted()</script>\n中文源文件';
  await fs.writeFile(path.join(project.path, '中文.tsx'), content);
  const result = await readProjectFile(project, '中文.tsx');
  assert.equal(result.kind, 'text');
  assert.equal(result.content, content);
  await fs.writeFile(path.join(project.path, 'empty.txt'), '');
  assert.equal((await readProjectFile(project, 'empty.txt')).content, '');
  await fs.writeFile(path.join(project.path, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文\r\n文本', 'utf16le')]));
  assert.equal((await readProjectFile(project, 'utf16.txt')).content, '中文\r\n文本');
});

test('binary and oversized files return a preview explanation without reading unbounded data', async t => {
  const { project } = await fixture(t);
  await fs.writeFile(path.join(project.path, 'binary.bin'), Buffer.from([0, 10, 254, 0]));
  await fs.writeFile(path.join(project.path, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  assert.equal((await readProjectFile(project, 'binary.bin')).kind, 'unsupported');
  assert.equal((await readProjectFile(project, 'large.txt')).kind, 'unsupported');
});

test('project file operations reject traversal, absolute paths, alternate streams and escaping links', async t => {
  const { project, directory } = await fixture(t);
  for (const value of ['../outside', 'src/../../outside', directory, 'C:\\Windows', '/etc', '\\\\server\\share', 'README.md:stream', 'bad\0name']) {
    await assert.rejects(listDirectory(project, value));
    await assert.rejects(readProjectFile(project, value));
  }
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside the project');
  await fs.symlink(outside, path.join(project.path, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(listDirectory(project, 'external'), /项目目录之外/);
  await assert.rejects(readProjectFile(project, 'external/private.txt'), /项目目录之外/);
});

test('refresh observes created and removed entries and handles vanished files', async t => {
  const { project } = await fixture(t);
  const file = path.join(project.path, 'new.txt');
  assert.equal((await listDirectory(project)).entries.length, 0);
  await fs.writeFile(file, 'new');
  assert.equal((await listDirectory(project)).entries[0].name, 'new.txt');
  await fs.unlink(file);
  assert.equal((await listDirectory(project)).entries.length, 0);
  await assert.rejects(readProjectFile(project, 'new.txt'), /ENOENT/);
});

test('PNG images above the text limit still get image previews', async t => {
  const { project } = await fixture(t);
  await fs.writeFile(path.join(project.path, '图片.PNG'), Buffer.alloc(2 * 1024 * 1024));
  const result = await readProjectFile(project, '图片.PNG');
  assert.equal(result.kind, 'image');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(Object.hasOwn(result, 'content'), false);
});

test('HTML defaults to a page preview and keeps source when small', async t => {
  const { project } = await fixture(t);
  const html = '<!doctype html><h1>预览页面</h1><script>window.ready=true</script>';
  await fs.writeFile(path.join(project.path, 'index.html'), html);
  const small = await readProjectFile(project, 'index.html');
  assert.equal(small.kind, 'html');
  assert.equal(small.content, html);
  await fs.writeFile(path.join(project.path, 'large.html'), '<!doctype html>' + ' '.repeat(2 * 1024 * 1024));
  const large = await readProjectFile(project, 'large.html');
  assert.equal(large.kind, 'html');
  assert.equal(large.content, null);
});
