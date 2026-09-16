const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { APP_ID, windowsAppId, repairShortcuts, refreshSearchIcons } = require('../electron/windows-integration.cjs');

test('development, portable and isolated test windows never reuse the installed application identity', () => {
  assert.equal(windowsAppId({ packaged: true, installed: true }), APP_ID);
  assert.notEqual(windowsAppId({ packaged: false }), APP_ID);
  assert.notEqual(windowsAppId({ packaged: true, installed: false }), APP_ID);
  const testId = windowsAppId({ packaged: true, installed: true, profile: '/test/profile-a' });
  assert.notEqual(testId, APP_ID);
  assert.equal(testId, windowsAppId({ packaged: true, installed: true, profile: '/test/profile-a' }));
  assert.notEqual(testId, windowsAppId({ packaged: true, installed: true, profile: '/test/profile-b' }));
});

test('search refresh backs up only this application cached icons and runs once per icon revision', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-grid-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'profile'), iconSource = path.join(root, 'icon.ico');
  const cache = path.join(root, 'Packages', 'Microsoft.Windows.Search_cw5n1h2txyewy', 'LocalState', 'AppIconCache', '150');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(iconSource, 'new app icon');
  const owned = path.join(cache, 'local_projectgrid_desktop');
  const foreign = path.join(cache, 'other_application');
  fs.writeFileSync(owned, 'old Electron bitmap'); fs.writeFileSync(foreign, 'foreign icon');
  const options = { localAppData: root, userData, iconSource };
  const result = refreshSearchIcons(options);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.changes.length, 1);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.readFileSync(result.changes[0].backup, 'utf8'), 'old Electron bitmap');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign icon');
  fs.writeFileSync(owned, 'regenerated branded bitmap');
  assert.deepEqual(refreshSearchIcons(options).changes, []);
  assert.equal(fs.readFileSync(owned, 'utf8'), 'regenerated branded bitmap');
});

test('repair quarantines only the conflicting Electron shortcut and keeps an idempotent branded search entry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-grid-shortcuts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = Object.fromEntries(['userData', 'programs', 'commonPrograms', 'desktop'].map(name => { const folder = path.join(root, name); fs.mkdirSync(folder); return [name, folder]; }));
  const executable = path.join(root, 'Project Grid.exe'), iconSource = path.join(root, 'icon.ico');
  fs.writeFileSync(iconSource, 'fixture icon');
  const old = path.join(folders.programs, 'Electron.lnk'), foreign = path.join(folders.commonPrograms, 'Electron.lnk'), menu = path.join(folders.programs, 'Project Grid.lnk');
  fs.writeFileSync(old, JSON.stringify({ target: path.join(root, 'electron.exe'), appUserModelId: APP_ID }));
  fs.writeFileSync(foreign, JSON.stringify({ target: path.join(root, 'electron.exe'), appUserModelId: 'another.application' }));
  fs.writeFileSync(menu, JSON.stringify({ target: executable, appUserModelId: APP_ID, args: '--preserve-user-argument' }));
  const shell = { readShortcutLink: file => JSON.parse(fs.readFileSync(file)), writeShortcutLink: (file, mode, options) => { const previous = mode === 'update' ? JSON.parse(fs.readFileSync(file)) : {}; fs.writeFileSync(file, JSON.stringify({ ...previous, ...options })); return true; } };
  const options = { ...folders, executable, iconSource, shell };
  const result = repairShortcuts(options);
  assert.deepEqual(result.warnings, []);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readdirSync(path.join(folders.userData, 'shortcut-backups')).length, 1);
  assert.equal(shell.readShortcutLink(foreign).appUserModelId, 'another.application');
  assert.equal(shell.readShortcutLink(menu).icon, result.icon);
  assert.equal(shell.readShortcutLink(menu).target, executable);
  assert.equal(shell.readShortcutLink(menu).args, '--preserve-user-argument');
  assert.equal(fs.existsSync(path.join(folders.desktop, 'Project Grid.lnk')), false, 'startup does not recreate a desktop shortcut the user removed');
  assert.deepEqual(repairShortcuts(options).changes, []);
});
