const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PAGE_SIZE = 200;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveProjectPath(project, relativePath = '') {
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || /[\0:]/.test(relativePath) || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('无效的项目文件路径。');
  }
  const root = await fs.realpath(project.path);
  const candidate = await fs.realpath(path.resolve(root, relativePath));
  if (!isWithin(root, candidate)) throw new Error('该链接指向项目目录之外，无法在此打开。');
  return candidate;
}

async function listDirectory(project, relativePath = '', offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效的目录页码。');
  const resolved = await resolveProjectPath(project, relativePath);
  const files = await fs.readdir(resolved, { withFileTypes: true });
  files.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name));
  const entries = files.slice(offset, offset + PAGE_SIZE).map(entry => ({
    name: entry.name,
    path: path.join(relativePath, entry.name).split(path.sep).join('/'),
    kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file',
  }));
  return { path: relativePath, entries, total: files.length, nextOffset: offset + entries.length < files.length ? offset + entries.length : null };
}

async function readProjectFile(project, relativePath) {
  if (!relativePath) throw new Error('请选择一个文件。');
  const resolved = await resolveProjectPath(project, relativePath);
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只能预览普通文件。');
    const base = { path: relativePath, name: path.basename(relativePath), size: stat.size, modifiedAt: stat.mtimeMs };
    if (stat.size > MAX_PREVIEW_BYTES) return { ...base, kind: 'unsupported', reason: '文件大于 1 MiB，请在 VS Code 中打开。' };
    // Bound reads even when Codex is growing the file concurrently.
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PREVIEW_BYTES) return { ...base, kind: 'unsupported', reason: '文件大于 1 MiB，请在 VS Code 中打开。' };
    const data = buffer.subarray(0, bytesRead);
    let encoding = 'utf-8';
    if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le';
    else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be';
    else if (data.includes(0)) return { ...base, kind: 'unsupported', reason: '二进制文件不支持文本预览。' };
    try {
      const content = new TextDecoder(encoding, { fatal: true }).decode(data);
      return { ...base, kind: 'text', content };
    } catch {
      return { ...base, kind: 'unsupported', reason: '此文件的编码不支持预览，请在 VS Code 中打开。' };
    }
  } finally { await handle.close(); }
}

module.exports = { listDirectory, readProjectFile, resolveProjectPath };
