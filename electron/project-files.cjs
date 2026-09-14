const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PAGE_SIZE = 200;
const TEXT_PAGE_BYTES = 256 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.apng': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

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
    const base = { path: relativePath, name: path.basename(relativePath), size: stat.size, modifiedAt: stat.mtimeMs };
    const extension = path.extname(relativePath).toLowerCase();
    const isHtml = extension === '.html' || extension === '.htm';
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
      return { ...base, kind: isHtml ? 'html' : 'text', content, page: { index, count, byteStart: readStart + byteStart, byteEnd: readStart + byteEnd, encoding } };
    } catch {
      return { ...base, kind: 'unsupported', reason: '此文件的编码不支持预览，请在 VS Code 中打开。' };
    }
  } finally { await handle.close(); }
}

module.exports = { listDirectory, readProjectFile, resolveProjectPath, IMAGE_TYPES, VIDEO_TYPES, TEXT_PAGE_BYTES };
