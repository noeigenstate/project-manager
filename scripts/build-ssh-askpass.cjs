const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform === 'win32') {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'integration', 'ssh-askpass.cs');
  const output = path.join(root, 'integration', 'ssh-askpass.exe');
  if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${output}`, source], { windowsHide: true, stdio: 'inherit' });
  }
} else {
  fs.chmodSync(path.join(__dirname, '..', 'integration', 'ssh-askpass.sh'), 0o755);
}
