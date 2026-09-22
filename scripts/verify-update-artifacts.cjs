const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const root = path.join(__dirname, '..');
const version = require('../package.json').version;
const installer = `Project-Grid-Setup-${version}-x64.exe`;
const release = path.join(root, 'release');
const feed = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
assert.equal(feed.version, version, 'update feed version must match the app');
assert.equal(feed.path, installer, 'the update feed must point to the installer');
const entry = feed.files.find(file => file.url === installer);
assert.ok(entry, 'installer must be present in the update feed');
const bytes = fs.readFileSync(path.join(release, installer));
const checksum = createHash('sha512').update(bytes).digest('base64');
assert.equal(entry.sha512, checksum, 'update download checksum must match the built installer');
assert.equal(feed.sha512, checksum);
assert.equal(entry.size, bytes.length);
assert.ok(fs.statSync(path.join(release, installer + '.blockmap')).size > 0);
const config = yaml.load(fs.readFileSync(path.join(release, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8'));
assert.equal(config.provider, 'github');
assert.equal(config.owner, 'noeigenstate');
assert.equal(config.repo, 'project-manager');
const resources = require('resedit');
const exe = resources.NtExecutable.from(fs.readFileSync(path.join(release, 'win-unpacked', 'Project Grid.exe')));
const entries = resources.NtExecutableResource.from(exe).entries;
const groups = resources.Resource.IconGroupEntry.fromEntries(entries);
assert.equal(groups.length, 1, 'the executable must not retain an Electron icon group');
assert.deepEqual(groups[0].icons.map(icon => icon.width || 256).sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256], 'Windows must have branded icons at taskbar, desktop and search sizes');
const sourceIcon = resources.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets/icon.ico')));
for (const [index, icon] of groups[0].icons.entries()) {
  const entry = entries.find(entry => entry.type === 3 && entry.id === icon.iconID && entry.lang === groups[0].lang);
  assert.ok(entry, 'each icon must have an embedded resource');
  assert.deepEqual(Buffer.from(entry.bin), Buffer.from(sourceIcon.icons[index].data.bin), 'the embedded icon must match the Project Grid source');
}
console.log(`PASS: ${installer}, latest.yml, blockmap, SHA-512 and embedded GitHub update configuration`);
console.log('PASS: seven embedded Project Grid icon sizes; no default Electron icon');
const asar = require('@electron/asar');
const archive = path.join(release, 'win-unpacked/resources/app.asar');
const packedFiles = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
assert.ok(!packedFiles.some(file => file.endsWith('.map')), 'production packages exclude source maps');
assert.ok(!packedFiles.some(file => /^node_modules\/node-pty\/(src|third_party|scripts|typings)\//.test(file)), 'native build sources and duplicate ConPTY copies stay out of the runtime');
assert.ok(!packedFiles.some(file => /^node_modules\/node-pty\/prebuilds\/(?!win32-x64\/)[^/]+\//.test(file)), 'x64 installer excludes other platform native binaries');
assert.ok(!packedFiles.some(file => file.startsWith('node_modules/node-addon-api/')), 'native build headers are not runtime dependencies');
for (const file of ['conpty.node', 'conpty_console_list.node', 'conpty/OpenConsole.exe', 'conpty/conpty.dll']) {
  assert.ok(fs.statSync(path.join(release, 'win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64', file)).size > 0, `keep required terminal runtime ${file}`);
}
for (const file of ['bootstrap.ps1', 'refresh-path.ps1', 'notify.ps1', 'remote-worker.py', 'ssh-askpass.exe', 'ssh-askpass.cjs', 'ssh-askpass.sh', 'file-clipboard.exe']) {
  assert.ok(fs.statSync(path.join(release, 'win-unpacked/resources/integration', file)).size > 0, `keep required integration ${file}`);
}
assert.ok(!fs.readdirSync(path.join(release, 'win-unpacked/resources/integration')).some(file => file === '__pycache__' || /\.(pyc|cs)$/.test(file)), 'integration ships runtime helpers, not build sources or Python caches');
console.log('PASS: lean x64 package retains the PTY/SSH/clipboard runtime and excludes debug/build/other-platform files');
