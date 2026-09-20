const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { randomUUID } = require('node:crypto');

const PAGE_SIZE = 200;
const TEXT_PAGE_BYTES = 256 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.apng': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const fileRevision = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function imageTypeFromBytes(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8))) return 'image/avif';
  return null;
}

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

async function readProjectFile(project, relativePath, pageIndex = 0) {
  if (!relativePath) throw new Error('请选择一个文件。');
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error('无效的文件页码。');
  const resolved = await resolveProjectPath(project, relativePath);
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只能预览普通文件。');
    const base = { path: relativePath, name: path.basename(relativePath), size: stat.size, modifiedAt: stat.mtimeMs, revision: fileRevision(stat) };
    const extension = path.extname(relativePath).toLowerCase();
    const isHtml = extension === '.html' || extension === '.htm';
    const isMarkdown = ['.md', '.markdown', '.mdown', '.mkd'].includes(extension);
    const signature = Buffer.alloc(Math.min(stat.size, 64));
    await handle.read(signature, 0, signature.length, 0);
    const imageType = imageTypeFromBytes(signature) || IMAGE_TYPES[extension];
    if (imageType) return { ...base, kind: 'image', mimeType: imageType };
    if (VIDEO_TYPES[extension]) return { ...base, kind: 'video', mimeType: VIDEO_TYPES[extension] };
    const prefix = Buffer.alloc(3);
    await handle.read(prefix, 0, prefix.length, 0);
    let encoding = 'utf-8';
    let bom = 0;
    if (prefix[0] === 0xff && prefix[1] === 0xfe) { encoding = 'utf-16le'; bom = 2; }
    else if (prefix[0] === 0xfe && prefix[1] === 0xff) { encoding = 'utf-16be'; bom = 2; }
    else if (prefix.equals(Buffer.from([0xef, 0xbb, 0xbf]))) bom = 3;
    const count = Math.max(1, Math.ceil((stat.size - bom) / TEXT_PAGE_BYTES));
    const index = Math.min(pageIndex, count - 1);
    const start = bom + index * TEXT_PAGE_BYTES;
    const end = Math.min(stat.size, start + TEXT_PAGE_BYTES);
    const readStart = Math.max(bom, start - 2);
    // Reads stay bounded even for multi-gigabyte files or files growing live.
    const buffer = Buffer.alloc(Math.max(0, Math.min(stat.size, end + 4) - readStart));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const boundary = position => {
      let offset = Math.max(0, Math.min(bytesRead, position - readStart));
      if (encoding === 'utf-8') {
        while (offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset++;
      } else if (offset >= 2 && offset + 1 < bytesRead) {
        const unit = i => encoding === 'utf-16le' ? buffer.readUInt16LE(i) : buffer.readUInt16BE(i);
        if (unit(offset) >= 0xdc00 && unit(offset) <= 0xdfff && unit(offset - 2) >= 0xd800 && unit(offset - 2) <= 0xdbff) offset += 2;
      }
      return offset;
    };
    const byteStart = boundary(start);
    const byteEnd = boundary(end);
    const data = buffer.subarray(byteStart, byteEnd);
    if (encoding === 'utf-8' && data.includes(0)) return { ...base, kind: 'unsupported', reason: '二进制文件不支持文本预览。' };
    try {
      const content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(data);
      return { ...base, kind: isHtml ? 'html' : isMarkdown ? 'markdown' : 'text', content, page: { index, count, byteStart: readStart + byteStart, byteEnd: readStart + byteEnd, encoding } };
    } catch {
      return { ...base, kind: 'unsupported', reason: '此文件的编码不支持预览，请在 VS Code 中打开。' };
    }
  } finally { await handle.close(); }
}

async function saveProjectFile(project, relativePath, pageIndex, revision, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('本次编辑内容超过 1 MB，请分段保存。');
  if (typeof revision !== 'string') throw new Error('请重新读取文件后编辑。');
  const preview = await readProjectFile(project, relativePath, pageIndex);
  if (!['text', 'html', 'markdown'].includes(preview.kind)) throw new Error('此文件不支持文本编辑。');
  if (preview.revision !== revision) throw new Error('文件已被其他程序修改，请刷新后重新编辑，避免覆盖新内容。');
  const resolved = await resolveProjectPath(project, relativePath);
  const temporary = path.join(path.dirname(resolved), `.project-grid-edit-${randomUUID()}.tmp`);
  let source = await fs.open(resolved, 'r+');
  let destination;
  try {
    const stat = await source.stat();
    if (fileRevision(stat) !== revision) throw new Error('文件已变化，请刷新后重新编辑。');
    // Textareas normalize line endings; retain the source file's convention.
    const normalized = preview.content.includes('\r\n') ? content.replace(/\r?\n/g, '\r\n') : content;
    let bytes = Buffer.from(normalized, preview.page.encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (preview.page.encoding === 'utf-16be') bytes = bytes.swap16();
    destination = await fs.open(temporary, 'wx', stat.mode);
    const copyRange = async (start, end) => {
      const buffer = Buffer.alloc(65536);
      for (let offset = start; offset < end;) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (!bytesRead) throw new Error('保存时文件发生变化，请刷新后重试。');
        await destination.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
    };
    await copyRange(0, preview.page.byteStart);
    await destination.writeFile(bytes);
    await copyRange(preview.page.byteEnd, stat.size);
    await destination.chmod(stat.mode); await destination.sync(); await destination.close(); destination = null;
    await source.close(); source = null;
    if (fileRevision(await fs.stat(resolved)) !== revision) throw new Error('文件已被其他程序修改，本次保存已取消。');
    await fs.rename(temporary, resolved);
  } finally {
    await source?.close(); await destination?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return readProjectFile(project, relativePath, pageIndex);
}

module.exports = { listDirectory, readProjectFile, saveProjectFile, resolveProjectPath, IMAGE_TYPES, VIDEO_TYPES, TEXT_PAGE_BYTES };
