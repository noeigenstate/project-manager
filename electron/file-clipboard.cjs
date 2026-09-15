const path = require('node:path');
const { spawn } = require('node:child_process');

function fileClipboard(integrationDir, action, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(integrationDir, 'file-clipboard.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('剪贴板暂时不可用，请重试。')); }, 10000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; if (output.length > 2 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', value => { error = (error + value).slice(-2000); });
    child.on('error', value => { clearTimeout(timer); reject(value); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code) { reject(new Error(error.trim() || '无法访问文件剪贴板。')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('文件剪贴板返回了无效数据。')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ action, paths }));
  });
}
module.exports = { fileClipboard };
