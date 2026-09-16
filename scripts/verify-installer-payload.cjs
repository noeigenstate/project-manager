const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
fs.mkdirSync(path.join(root, '.test-output'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, '.test-output', 'installer-payload-'));
const outer = path.join(output, 'nsis'), installed = path.join(output, 'installed');
const sevenZip = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor/7z-x64.exe');
const extract = (filename, directory, entries = [], tool = sevenZip) => execFileSync(tool, ['x', filename, `-o${directory}`, '-y', ...entries], { windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
(async () => {
  extract(path.join(root, 'release', `Project-Grid-Setup-${version}-x64.exe`), outer, ['$PLUGINSDIR\\app-64.7z', '$R0\\Uninstall Project Grid.exe']);
  // The NSIS container uses Deflate, but app-64.7z may contain newer filters
  // such as ARM64. Decode that payload with the exact toolset that built it.
  extract(path.join(outer, '$PLUGINSDIR', 'app-64.7z'), installed, [], await getPath7za());
  fs.copyFileSync(path.join(outer, '$R0', 'Uninstall Project Grid.exe'), path.join(installed, 'Uninstall Project Grid.exe'));
  const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  for (const relative of ['Project Grid.exe', 'resources/app.asar']) assert.equal(digest(path.join(installed, relative)), digest(path.join(root, 'release/win-unpacked', relative)), `installer payload differs: ${relative}`);
  const executable = path.join(installed, 'Project Grid.exe');
  fs.writeFileSync(path.join(root, '.test-output/installer-payload.json'), JSON.stringify({ version, executable, sha256: digest(executable) }));
  console.log(`PASS: actual NSIS payload matches the verified app and contains its uninstaller; ${executable}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
