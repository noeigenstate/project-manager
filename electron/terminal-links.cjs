const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { resolveProjectPath } = require('./project-files.cjs');

async function resolveTerminalLink(project, target) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096 || /[\x00-\x1f\x7f]/.test(target)) throw new Error('无效的链接。');
  let value = target.trim();
  if (/^www\./i.test(value)) value = `https://${value}`;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error('无效的网页链接。');
    return { kind: 'external', url: url.href };
  }
  if (/^file:\/\//i.test(value)) value = fileURLToPath(new URL(value));
  else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('只支持网页链接和项目内文件。');
  const candidates = [value, value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')];
  for (const candidate of new Set(candidates)) {
    const relativePath = path.relative(project.path, path.resolve(project.path, candidate));
    try {
      const resolved = await resolveProjectPath(project, relativePath);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) return { kind: 'directory', path: resolved };
      if (stat.isFile()) return { kind: 'file', path: relativePath.split(path.sep).join('/') };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && candidate === candidates.at(-1)) throw error;
    }
  }
  throw new Error('未找到链接文件。相对路径从当前项目根目录开始。');
}

module.exports = { resolveTerminalLink };
