const path = require('node:path');

function projectPaths(project, paths, format, remoteRoot) {
  if (!['absolute', 'relative'].includes(format) || !Array.isArray(paths) || !paths.length || paths.length > 2000) throw new Error('请选择要复制路径的文件。');
  const remote = project.kind === 'ssh';
  if (remote && format === 'absolute' && !remoteRoot?.startsWith('/')) throw new Error('请先连接 SSH 主机。');
  return [...new Set(paths)].map(value => {
    if (typeof value !== 'string' || value.length > 4096 || /[\0-\x1f:]/.test(value) || value.startsWith('/') || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('无效的项目文件路径。');
    const relative = value.replace(/\\/g, '/');
    if (format === 'relative') return relative || '.';
    return remote ? path.posix.resolve(remoteRoot, relative) : path.resolve(project.path, relative);
  }).join('\n');
}

module.exports = { projectPaths };
